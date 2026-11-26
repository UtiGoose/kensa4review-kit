import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, Finding } from "../core/types";
import { fingerprint, globToRegExp } from "../core/util";

export interface Endpoint {
  file: string;
  line: number;
  className: string;
  method: string;
  http: string[];
  path: string;
  security: string | null;
  securityLevel: "method" | "class" | null;
  public: boolean;
}

// Classifies an endpoint's security as public, login-only, role based or none.
export function strength(endpoint: Endpoint): "public" | "authenticated" | "role" | "none" {
  if (endpoint.public) return "public";
  const security = endpoint.security ?? "";
  if (!security) return "none";
  if (/permitAll\(\)|@PermitAll/.test(security)) return "public";
  if (/^@(Secured|RolesAllowed|DenyAll)|has(Any)?(Role|Authority)|hasPermission|@[\w$]+\.|denyAll|#/.test(security)) return "role";
  return "authenticated";
}

interface Annotation {
  name: string;
  args: string;
  start: number;
  end: number;
}

const mappingNames: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: "",
};
const securityNames = ["PreAuthorize", "Secured", "RolesAllowed", "PermitAll", "DenyAll", "PostAuthorize"];

// Replaces comments with spaces so offsets and lines stay the same.
export function stripComments(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") {
        result += " ";
        i++;
      }
    } else if (source.startsWith("/*", i)) {
      while (i < source.length && !source.startsWith("*/", i)) {
        result += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      result += "  ";
      i += 2;
    } else if (source[i] === '"') {
      const block = source.startsWith('"""', i) ? source.indexOf('"""', i + 3) : -2;
      const end = block === -2 ? nextQuote(source, i) : block < 0 ? source.length : block + 3;
      result += source.slice(i, end);
      i = end;
    } else {
      result += source[i++];
    }
  }
  return result;
}

// Returns the index after the closing quote of a string literal.
function nextQuote(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length && source[i] !== '"' && source[i] !== "\n") {
    if (source[i] === "\\") i++;
    i++;
  }
  return i + 1;
}

// Lists annotations with their argument text and offsets.
function annotations(source: string): Annotation[] {
  const result: Annotation[] = [];
  const pattern = /@([A-Za-z_][\w.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const name = match[1].split(".").pop() ?? match[1];
    let end = pattern.lastIndex;
    let args = "";
    let j = end;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] === "(") {
      let depth = 0;
      let k = j;
      for (; k < source.length; k++) {
        if (source[k] === '"') {
          k = nextQuote(source, k) - 1;
          continue;
        }
        if (source[k] === "(") depth++;
        if (source[k] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      args = source.slice(j + 1, k);
      end = k + 1;
      pattern.lastIndex = end;
    }
    result.push({ name, args, start: match.index, end });
  }
  return result;
}

// Extracts the string literal paths from mapping annotation arguments.
function mappingPaths(args: string): string[] {
  if (!args.trim()) return [""];
  const named = args.match(/\b(?:value|path)\s*=\s*(\{[^}]*\}|"(?:[^"\\]|\\.)*"|[\w.]+)/);
  const target = named ? named[1] : /^\s*(\{[^}]*\}|"(?:[^"\\]|\\.)*")/.test(args) ? args : "";
  const literals = [...target.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => item[1]);
  if (literals.length) return literals;
  const constant = target.match(/^[\s{]*([\w.]+)/);
  return [constant ? `{${constant[1]}}` : ""];
}

// Joins a class path and a method path into one URL path.
function joinPath(base: string, path: string): string {
  const joined = `/${base}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

// Returns the 1-based line number of an offset.
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

// Parses the endpoints of one controller source file.
export function parseController(file: string, original: string): Endpoint[] {
  const source = stripComments(original);
  if (!/@(Rest)?Controller\b/.test(source)) return [];
  const all = annotations(source);
  const classMatch = /\b(class|record)\s+(\w+)/.exec(source);
  if (!classMatch) return [];
  const classStart = classMatch.index;
  const className = classMatch[2];
  const classAnnotations = all.filter((item) => item.end <= classStart);
  const classMapping = classAnnotations.find((item) => item.name === "RequestMapping");
  const classSecurity = classAnnotations.find((item) => securityNames.includes(item.name));
  const bases = classMapping ? mappingPaths(classMapping.args) : [""];
  const endpoints: Endpoint[] = [];
  const members = all.filter((item) => item.start > classStart);
  let index = 0;
  while (index < members.length) {
    const group: Annotation[] = [members[index]];
    while (
      index + 1 < members.length &&
      /^[\s]*$/.test(source.slice(members[index].end, members[index + 1].start))
    ) {
      index++;
      group.push(members[index]);
    }
    index++;
    const mapping = group.find((item) => item.name in mappingNames);
    if (!mapping) continue;
    const after = source.slice(group[group.length - 1].end);
    const signature = after.match(/^[^;{=]*?\b(\w+)\s*\(/);
    if (!signature) continue;
    let http = mappingNames[mapping.name] ? [mappingNames[mapping.name]] : [];
    if (!http.length) {
      http = [...mapping.args.matchAll(/RequestMethod\.(\w+)/g)].map((item) => item[1]);
      if (!http.length) http = ["ANY"];
    }
    const security = group.find((item) => securityNames.includes(item.name));
    for (const base of bases) {
      for (const path of mappingPaths(mapping.args)) {
        endpoints.push({
          file,
          line: lineAt(source, mapping.start),
          className,
          method: signature[1],
          http,
          path: joinPath(base, path),
          security: security ? `@${security.name}(${security.args.trim()})` : classSecurity ? `@${classSecurity.name}(${classSecurity.args.trim()})` : null,
          securityLevel: security ? "method" : classSecurity ? "class" : null,
          public: false,
        });
      }
    }
  }
  return endpoints;
}

// Finds paths declared with permitAll() in security configuration code.
export function permitAllPaths(source: string): string[] {
  const text = stripComments(source);
  const paths: string[] = [];
  for (const match of text.matchAll(/requestMatchers\s*\(([^)]*)\)\s*\.\s*permitAll\s*\(/g)) {
    paths.push(...[...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
  }
  return paths;
}

// Turns the endpoint inventory into findings.
export function endpointFindings(endpoints: Endpoint[]): Finding[] {
  const findings: Finding[] = [];
  for (const endpoint of endpoints) {
    const level = strength(endpoint);
    if (level === "role") continue;
    const label = `${endpoint.http.join("/")} ${endpoint.path} (${endpoint.className}.${endpoint.method})`;
    const text = {
      public: { rule: "public-endpoint", title: "Public API", severity: "info", message: `${label} can be called without authentication. Confirm that it is meant to be public.` },
      none: { rule: "missing-authorization", title: "API without authorization annotation", severity: "medium", message: `${label} has no authorization annotation, so any signed-in user may be able to call it. Check the permission checks in the service layer.` },
      authenticated: { rule: "authenticated-only", title: "API that only requires sign-in", severity: "low", message: `${label} is protected only by ${endpoint.security} without a role or permission check. Check the permission checks in the service layer.` },
    }[level];
    findings.push({
      module: "endpoints",
      rule: text.rule,
      title: text.title,
      severity: text.severity as Finding["severity"],
      category: "security",
      message: text.message,
      file: endpoint.file,
      line: endpoint.line,
      fingerprint: fingerprint("endpoints", text.rule, endpoint.className, endpoint.method, endpoint.http.join(","), endpoint.path),
    });
  }
  return findings;
}

export const endpointsModule: CheckModule = {
  id: "endpoints",
  title: "API authorization inventory",
  modes: ["quick", "standard"],
  applies: (project) => (project.javaSources.length ? null : "no Java sources"),
  async run(ctx) {
    const { root, javaSources } = ctx.project;
    const endpoints: Endpoint[] = [];
    const permitted: string[] = [];
    for (const file of javaSources) {
      const source = readFileSync(join(root, file), "utf8");
      endpoints.push(...parseController(file, source));
      if (/permitAll/.test(source)) permitted.push(...permitAllPaths(source));
    }
    const patterns = permitted.map((path) => globToRegExp(path.replace(/^\//, "")));
    for (const endpoint of endpoints) {
      endpoint.public = patterns.some((pattern) => pattern.test(endpoint.path.replace(/^\//, "")));
    }
    writeFileSync(join(ctx.rawDir, "endpoints.json"), JSON.stringify({ permitAll: permitted, endpoints }, null, 2));
    const levels = endpoints.map(strength);
    const countOf = (level: string) => levels.filter((item) => item === level).length;
    ctx.log(`${endpoints.length} APIs: ${countOf("role")} with permission checks, ${countOf("authenticated")} sign-in only, ${countOf("none")} without annotation, ${countOf("public")} public`);
    return endpointFindings(endpoints);
  },
};
