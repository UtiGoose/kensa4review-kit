import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml";
import type { CheckModule, Finding, Severity } from "../core/types";
import { fingerprint } from "../core/util";

export interface Property {
  key: string;
  value: string;
  line: number;
  profile: string;
  file: string;
}

const devProfiles = /^(dev|local|test|it|e2e|ci)([-_].*)?$/i;

// Reads Spring properties with their profile and line.
export function readSpringConfig(file: string, text: string): Property[] {
  const name = basename(file);
  const fileProfile = name.match(/^application-([\w-]+)\./)?.[1] ?? "default";
  const result: Property[] = [];
  if (name.endsWith(".properties")) {
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) return;
      const match = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
      if (match) result.push({ key: match[1], value: match[2], line: index + 1, profile: fileProfile, file });
    });
    return result;
  }
  const counter = new LineCounter();
  for (const doc of parseAllDocuments(text, { lineCounter: counter })) {
    const entries: Property[] = [];
    const walk = (node: Node | null | undefined, prefix: string) => {
      if (isMap(node)) {
        for (const item of node.items) {
          const key = isScalar(item.key) ? String(item.key.value) : String(item.key);
          walk(item.value as Node, prefix ? `${prefix}.${key}` : key);
        }
      } else if (isSeq(node)) {
        node.items.forEach((item, index) => walk(item as Node, `${prefix}[${index}]`));
      } else if (isScalar(node)) {
        const line = node.range ? counter.linePos(node.range[0]).line : 0;
        entries.push({ key: prefix, value: String(node.value ?? ""), line, profile: fileProfile, file });
      }
    };
    walk(doc.contents as Node, "");
    const activation = entries.find((entry) => entry.key === "spring.config.activate.on-profile" || entry.key === "spring.profiles");
    const profile = activation ? activation.value : fileProfile;
    result.push(...entries.map((entry) => ({ ...entry, profile })));
  }
  return result;
}

const secretKey = /(password|passwd|secret|api-?key|apikey|token|credential|private-?key)/i;
const notSecret = /(expir|ttl|-ms$|days$|seconds$|minutes$|hours$|length$|size$|enabled$|header|cookie-name|url$|uri$|path$|limit$|count$|validity|lifetime|duration|type$|algorithm$)/i;

// Splits ${NAME:default} into the variable and its default value.
function placeholder(value: string): { variable: string; fallback: string | null } | null {
  const match = value.match(/^\$\{([^:}]+)(?::(.*))?\}$/);
  if (!match) return null;
  return { variable: match[1], fallback: match[2] ?? null };
}

// Returns the effective value, using the placeholder default when present.
function effective(value: string): string {
  const parsed = placeholder(value);
  return parsed ? (parsed.fallback ?? "") : value;
}

// Masks a secret for display.
function mask(value: string): string {
  return value.length <= 6 ? "******" : `${value.slice(0, 4)}… (${value.length} chars)`;
}

// Checks Spring configuration properties and returns findings.
export function checkSpring(properties: Property[], usesJpa: boolean): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, severity: Severity, category: Finding["category"], title: string, message: string, property: Property, hint?: string) =>
    findings.push({
      module: "spring-config",
      rule,
      title,
      severity,
      category,
      message,
      hint,
      file: property.file,
      line: property.line,
      fingerprint: fingerprint("spring-config", rule, property.file, property.key, property.profile),
    });
  const isDev = (property: Property) => devProfiles.test(property.profile);
  const byProfile = (key: string, profile: string) =>
    properties.find((property) => property.key === key && property.profile === profile);
  for (const property of properties) {
    const leaf = property.key.split(".").pop() ?? property.key;
    const value = property.value.trim();
    if (secretKey.test(leaf) && !notSecret.test(leaf) && value) {
      const parsed = placeholder(value);
      const secret = parsed ? (parsed.fallback ?? "") : value;
      if (secret) {
        const realistic = secret.length >= 20 && !/(replace|change|example|dummy|sample|your-|xxx)/i.test(secret);
        const prodOverride = byProfile(property.key, "prod");
        let severity: Severity = parsed ? (realistic ? "high" : "medium") : "high";
        if (isDev(property)) severity = "low";
        const where = parsed ? `default value ${mask(secret)} is used when ${parsed.variable} is not set` : `value ${mask(secret)} is written in the file`;
        const override = prodOverride && property.profile !== "prod" ? " (overridden in the prod profile)" : "";
        add(
          parsed ? "secret-default" : "secret-literal",
          severity,
          "secret",
          "Secret in configuration file",
          `${property.key}: ${where}${override}.`,
          property,
          "Do not give secrets a default value; pass them from environment variables or a secret store.",
        );
      }
    }
    if (isDev(property)) continue;
    const actual = effective(value).toLowerCase();
    if (property.key === "management.endpoints.web.exposure.include") {
      const items = actual.split(",").map((item) => item.trim());
      if (items.includes("*")) {
        add("actuator-all", "high", "security", "All Actuator endpoints exposed", "exposure.include is set to *.", property);
      } else {
        const risky = items.filter((item) => ["env", "heapdump", "threaddump", "configprops", "beans", "mappings", "loggers", "shutdown", "logfile"].includes(item));
        if (risky.length) add("actuator-risky", "medium", "security", "Sensitive Actuator endpoints exposed", `${risky.join(", ")} are exposed.`, property);
      }
    }
    if (property.key === "management.endpoint.health.show-details" && actual === "always") {
      add("health-details", "low", "security", "Health details always shown", "show-details: always reveals internal components to anyone.", property);
    }
    if (property.key === "spring.jpa.show-sql" && actual === "true") {
      add("show-sql", "low", "performance", "SQL printed to stdout", `show-sql is enabled in the ${property.profile} profile.`, property);
    }
    if (property.key === "spring.jpa.hibernate.ddl-auto" && ["update", "create", "create-drop"].includes(actual)) {
      add("ddl-auto", "high", "config", "Automatic schema changes", `ddl-auto: ${actual} can alter or drop data.`, property);
    }
    if (/^logging\.level\./.test(property.key) && ["debug", "trace"].includes(actual)) {
      add("debug-logging", "low", "performance", "DEBUG/TRACE logging by default", `${property.key} defaults to ${actual.toUpperCase()} (${property.profile} profile).`, property);
    }
    if (/allowed-origins?(\[\d+\])?$|allowed-origin-patterns?(\[\d+\])?$/.test(property.key) && actual.split(",").some((item) => item.trim() === "*")) {
      add("cors-wildcard", "high", "security", "CORS allows any origin", `${property.key} is set to *.`, property);
    }
    if (/^server\.error\.include-(stacktrace|exception)$/.test(property.key) && ["always", "true"].includes(actual)) {
      add("error-details", "medium", "security", "Error details exposed", `${property.key}: ${actual} returns stack traces and exception details.`, property);
    }
  }
  const docsEnabled = properties.some((property) => property.key.startsWith("springdoc."));
  if (docsEnabled) {
    const disabled = properties.some(
      (property) =>
        property.profile === "prod" &&
        ["springdoc.api-docs.enabled", "springdoc.swagger-ui.enabled"].includes(property.key) &&
        effective(property.value).toLowerCase() === "false",
    );
    const anchor = properties.find((property) => property.key.startsWith("springdoc."));
    if (!disabled && anchor) {
      add("springdoc-prod", "medium", "security", "API documentation may be public in production", "The prod profile does not set springdoc.api-docs.enabled: false.", anchor);
    }
  }
  if (usesJpa) {
    const osiv = properties.find((property) => property.key === "spring.jpa.open-in-view");
    if (!osiv || effective(osiv.value).toLowerCase() !== "false") {
      const anchor = osiv ?? properties.find((property) => property.key.startsWith("spring.jpa.")) ?? properties[0];
      if (anchor) {
        add("open-in-view", "medium", "performance", "Open Session in View enabled", "spring.jpa.open-in-view is not false. Each request holds a database connection until the response is written, and lazy loading runs outside the service layer.", anchor);
      }
    }
  }
  return findings;
}

export const springConfigModule: CheckModule = {
  id: "spring-config",
  title: "Spring configuration",
  modes: ["quick", "standard"],
  applies: (project) => (project.springConfigs.length ? null : "no application.yml or properties"),
  async run(ctx) {
    const { root, springConfigs, files } = ctx.project;
    const properties = springConfigs.flatMap((file) => readSpringConfig(file, readFileSync(join(root, file), "utf8")));
    const buildFiles = files.filter((file) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml|libs\.versions\.toml)$/.test(file));
    const usesJpa = buildFiles.some((file) => readFileSync(join(root, file), "utf8").includes("data-jpa"));
    return checkSpring(properties, usesJpa);
  },
};
