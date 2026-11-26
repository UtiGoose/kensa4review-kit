import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import type { Accepted, Finding, Profile, ToolPaths } from "./types";
import { matchesAny } from "./util";

const defaultExclude = ["**/node_modules", "**/build", "**/dist", "**/target", "**/.gradle", ".git"];

// Loads the project profile from the project or from the tool.
export function loadProfile(tool: ToolPaths, projectRoot: string, projectName: string): Profile {
  const candidates = [
    join(projectRoot, ".review", "profile.yml"),
    join(tool.root, "projects", projectName.toLowerCase(), "profile.yml"),
  ];
  const source = candidates.find((file) => existsSync(file)) ?? null;
  const data = source ? (parse(readFileSync(source, "utf8")) ?? {}) : {};
  return {
    source,
    dir: source ? dirname(source) : join(tool.root, "projects", basename(projectName).toLowerCase()),
    exclude: [...defaultExclude, ...(data.exclude ?? [])],
    skip: data.modules?.skip ?? [],
    semgrepRegistry: data.semgrep?.registry,
    flywayPolicy: data.flyway?.policy === "off" ? "off" : "warn",
    accepted: ((data.accepted ?? []) as Record<string, unknown>[]).map((entry) => {
      const expires = entry.expires as unknown;
      return {
        ...entry,
        reason: String(entry.reason ?? ""),
        expires: expires instanceof Date ? expires.toISOString().slice(0, 10) : expires ? String(expires) : undefined,
      } as Accepted;
    }),
  };
}

interface BaselineEntry {
  fingerprint: string;
  module: string;
  rule: string;
  severity: string;
  title: string;
  file?: string;
}

// Reads the saved baseline fingerprints.
export function readBaseline(profile: Profile): Set<string> {
  const file = join(profile.dir, "baseline.json");
  if (!existsSync(file)) return new Set();
  const data = JSON.parse(readFileSync(file, "utf8")) as { findings: BaselineEntry[] };
  return new Set(data.findings.map((entry) => entry.fingerprint));
}

// Saves the given findings as the new baseline.
export function writeBaseline(profile: Profile, findings: Finding[]): string {
  mkdirSync(profile.dir, { recursive: true });
  const file = join(profile.dir, "baseline.json");
  const entries: BaselineEntry[] = findings
    .filter((finding) => finding.status !== "accepted")
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      module: finding.module,
      rule: finding.rule,
      severity: finding.severity,
      title: finding.title,
      file: finding.file,
    }))
    .sort((a, b) => `${a.module}${a.file}${a.rule}`.localeCompare(`${b.module}${b.file}${b.rule}`));
  writeFileSync(file, `${JSON.stringify({ updatedAt: new Date().toISOString(), findings: entries }, null, 2)}\n`);
  return file;
}

// Returns the accepted entry that covers the finding, if any.
function acceptedFor(finding: Finding, accepted: Accepted[], today: string): Accepted | undefined {
  return accepted.find((entry) => {
    if (entry.expires && entry.expires < today) return false;
    if (entry.fingerprint && entry.fingerprint !== finding.fingerprint) return false;
    if (entry.module && entry.module !== finding.module) return false;
    if (entry.rule && entry.rule !== finding.rule) return false;
    if (entry.path && !(finding.file && matchesAny(finding.file, [entry.path]))) return false;
    if (entry.text && !`${finding.title} ${finding.message}`.includes(entry.text)) return false;
    return Boolean(entry.fingerprint || entry.rule || entry.path || entry.module || entry.text);
  });
}

// Marks each finding as new, known (baseline) or accepted.
export function classify(findings: Finding[], profile: Profile, baseline: Set<string>): Finding[] {
  const today = new Date().toISOString().slice(0, 10);
  const expired = profile.accepted.filter((entry) => entry.expires && entry.expires < today);
  return findings.map((finding) => {
    const accepted = acceptedFor(finding, profile.accepted, today);
    if (accepted) return { ...finding, status: "accepted", note: accepted.reason };
    const lapsed = acceptedFor(finding, expired.map((entry) => ({ ...entry, expires: undefined })), today);
    const note = lapsed ? `Acceptance expired on ${lapsed.expires}: ${lapsed.reason}` : undefined;
    return { ...finding, status: baseline.has(finding.fingerprint) ? "baseline" : "new", note };
  });
}
