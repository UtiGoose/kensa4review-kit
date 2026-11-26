import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, Finding, Severity } from "../core/types";
import { fingerprint } from "../core/util";

export interface Directive {
  name: string;
  args: string[];
  line: number;
  children?: Directive[];
}

// Parses an nginx configuration into nested directives.
export function parseNginx(text: string): Directive[] {
  const tokens: { value: string; line: number }[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\n") {
      line++;
      i++;
    } else if (/\s/.test(char)) {
      i++;
    } else if (char === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "{" || char === "}" || char === ";") {
      tokens.push({ value: char, line });
      i++;
    } else if (char === '"' || char === "'") {
      let value = "";
      const quote = char;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        if (text[i] === "\n") line++;
        value += text[i];
        i++;
      }
      i++;
      tokens.push({ value, line });
    } else {
      let value = "";
      while (i < text.length && !/[\s{};]/.test(text[i])) value += text[i++];
      tokens.push({ value, line });
    }
  }
  let position = 0;
  const block = (): Directive[] => {
    const result: Directive[] = [];
    let current: Directive | null = null;
    while (position < tokens.length) {
      const token = tokens[position++];
      if (token.value === "}") return result;
      if (token.value === ";") {
        if (current) result.push(current);
        current = null;
      } else if (token.value === "{") {
        const directive = current ?? { name: "", args: [], line: token.line };
        directive.children = block();
        result.push(directive);
        current = null;
      } else if (!current) {
        current = { name: token.value, args: [], line: token.line };
      } else {
        current.args.push(token.value);
      }
    }
    return result;
  };
  return block();
}

const securityHeaders: { name: string; severity: Severity; message: string }[] = [
  { name: "content-security-policy", severity: "medium", message: "Content-Security-Policy is not set." },
  { name: "x-frame-options", severity: "medium", message: "X-Frame-Options (or CSP frame-ancestors) is not set." },
  { name: "x-content-type-options", severity: "low", message: "X-Content-Type-Options: nosniff is not set." },
  { name: "referrer-policy", severity: "low", message: "Referrer-Policy is not set." },
  { name: "strict-transport-security", severity: "low", message: "Strict-Transport-Security is not set (check the TLS terminating layer if TLS ends elsewhere)." },
];

// Returns the lower-case header names added directly in a block.
function ownHeaders(children: Directive[] = []): Map<string, Directive> {
  const headers = new Map<string, Directive>();
  for (const directive of children) {
    if (directive.name === "add_header" && directive.args[0]) headers.set(directive.args[0].toLowerCase(), directive);
  }
  return headers;
}

// Parses a size such as 110m into bytes.
function sizeBytes(value: string): number {
  const match = value.match(/^(\d+)([kKmMgG]?)$/);
  if (!match) return 0;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Number(match[1]) * unit;
}

// Checks one parsed nginx file and returns its findings.
export function checkNginx(file: string, directives: Directive[]): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, severity: Severity, title: string, message: string, line: number, category: Finding["category"] = "security") =>
    findings.push({
      module: "nginx",
      rule,
      title,
      severity,
      category,
      message,
      file,
      line,
      fingerprint: fingerprint("nginx", rule, file, message),
    });
  const servers: { server: Directive; inherited: Map<string, Directive> }[] = [];
  const collect = (items: Directive[], inherited: Map<string, Directive>) => {
    for (const item of items) {
      if (!item.children) continue;
      if (item.name === "server") {
        const own = ownHeaders(item.children);
        servers.push({ server: item, inherited: own.size ? own : inherited });
      } else if (item.name === "http" || item.name === "") {
        const own = ownHeaders(item.children);
        collect(item.children, own.size ? own : inherited);
      }
    }
  };
  collect(directives, new Map());
  const all: Directive[] = [];
  const flatten = (items: Directive[]) => {
    for (const item of items) {
      all.push(item);
      if (item.children) flatten(item.children);
    }
  };
  flatten(directives);
  for (const { server, inherited } of servers) {
    const effective = inherited;
    const names = new Set(effective.keys());
    const csp = effective.get("content-security-policy")?.args[1] ?? "";
    for (const header of securityHeaders) {
      if (names.has(header.name)) continue;
      if (header.name === "x-frame-options" && /frame-ancestors/i.test(csp)) continue;
      add(`missing-${header.name}`, header.severity, "Missing security header", header.message, server.line);
    }
    const visit = (items: Directive[], parent: Map<string, Directive>) => {
      for (const item of items) {
        if (item.name !== "location" || !item.children) continue;
        const own = ownHeaders(item.children);
        if (own.size) {
          const lost = [...parent.keys()].filter(
            (name) => !own.has(name) && securityHeaders.some((header) => header.name === name),
          );
          if (lost.length) {
            add(
              "add-header-inheritance",
              "medium",
              "add_header in a location drops the security headers",
              `location ${item.args.join(" ")} defines its own add_header, so the inherited ${lost.join(", ")} are not sent.`,
              item.line,
            );
          }
        }
        visit(item.children, own.size ? own : parent);
      }
    };
    visit(server.children ?? [], effective);
  }
  const tokens = all.find((item) => item.name === "server_tokens");
  if (servers.length && (!tokens || tokens.args[0] !== "off")) {
    add("server-tokens", "low", "server_tokens is not off", "Error pages and the Server header reveal the nginx version.", tokens?.line ?? servers[0].server.line);
  }
  for (const item of all) {
    if (item.name === "add_header" && item.args[0]?.toLowerCase() === "x-xss-protection") {
      add("x-xss-protection", "info", "Deprecated header", "Current browsers ignore X-XSS-Protection. Use a Content-Security-Policy instead.", item.line);
    }
    if (item.name === "autoindex" && item.args[0] === "on") {
      add("autoindex", "medium", "Directory listing enabled", "autoindex on exposes file listings.", item.line);
    }
    if (item.name === "ssl_protocols" && item.args.some((arg) => /^TLSv1(\.1)?$/.test(arg))) {
      add("weak-tls", "high", "Outdated TLS enabled", `ssl_protocols includes ${item.args.join(" ")}. Allow TLSv1.2 or later only.`, item.line);
    }
    if (item.name === "client_max_body_size" && sizeBytes(item.args[0] ?? "") > 50 * 1024 ** 2) {
      add("large-body", "info", "Large upload limit", `client_max_body_size ${item.args[0]}. Make sure it is limited to the locations that need it.`, item.line, "performance");
    }
  }
  return findings;
}

export const nginxModule: CheckModule = {
  id: "nginx",
  title: "nginx configuration",
  modes: ["quick", "standard"],
  applies: (project) => (project.nginxConfs.length ? null : "no nginx configuration"),
  async run(ctx) {
    return ctx.project.nginxConfs.flatMap((file) =>
      checkNginx(file, parseNginx(readFileSync(join(ctx.project.root, file), "utf8"))),
    );
  },
};
