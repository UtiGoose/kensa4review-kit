import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { categoryLabel, type Finding, type RunResult, type Severity, severityLabel, severityOrder, statusLabel } from "../core/types";
import { describe } from "../detect/detect";
import { type Endpoint, strength } from "../modules/endpoints";
import { count, duration, sorted } from "./summary";
import { type Cell, type Sheet, style, workbook } from "./xlsx";

const severityStyle: Record<Severity, number> = {
  critical: style.critical,
  high: style.high,
  medium: style.medium,
  low: style.low,
  info: style.info,
};

const numeric = new Set(["No", "New", "Known", "Accepted", "Total", "Findings", "Time", "Line"]);

const protection = {
  role: "Role or permission check",
  authenticated: "Sign-in only",
  none: "No annotation",
  public: "Public",
};

const header = (...names: string[]): Cell[] => names.map((value) => ({ value, style: numeric.has(value) ? style.headerRight : style.header }));
const severityCell = (severity: Severity): Cell => ({ value: severityLabel[severity], style: severityStyle[severity] });
const statusCell = (finding: Finding): Cell => {
  const status = finding.status ?? "new";
  return { value: statusLabel[status], style: status === "new" ? style.fresh : status === "accepted" ? style.muted : style.normal };
};

// Formats a date as local yyyy-mm-dd hh:mm.
function localTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Builds the summary sheet.
function summarySheet(result: RunResult): Sheet {
  const counts = count(result.findings);
  const seconds = (new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()) / 1000;
  const label = (value: string): Cell => ({ value, style: style.label });
  const rows: Sheet["rows"] = [
    [{ value: `Review report: ${result.project.name}`, style: style.title }],
    [],
    [label("Project"), result.project.root],
    [label("Started"), localTime(result.startedAt)],
    [label("Duration"), duration(seconds)],
    [label("Mode"), result.mode === "quick" ? "Quick (no build)" : "Standard (all checks)"],
    [label("Project profile"), result.profile.source ?? "none (defaults)"],
    ...describe(result.project).map((line, i) => [label(i === 0 ? "Detected" : ""), line]),
    [],
    [{ value: "Findings by severity", style: style.bold }],
    header("Severity", "New", "Known", "Accepted", "Total"),
    ...severityOrder.map((severity) => {
      const item = counts.bySeverity[severity];
      return [severityCell(severity), item.new, item.baseline, item.accepted, item.new + item.baseline + item.accepted];
    }),
    [
      { value: "Total", style: style.bold },
      { value: counts.total.new, style: style.bold },
      { value: counts.total.baseline, style: style.bold },
      { value: counts.total.accepted, style: style.bold },
      { value: counts.total.new + counts.total.baseline + counts.total.accepted, style: style.bold },
    ],
    [],
    [{ value: "Modules", style: style.bold }],
    header("Module", "Status", "Findings", "Time", "Note"),
    ...result.modules.map((module) => [
      module.title,
      { value: { ok: "Done", failed: "Failed", skipped: "Skipped" }[module.status], style: { ok: style.ok, failed: style.failed, skipped: style.label }[module.status] },
      module.count,
      { value: duration(module.seconds), style: style.right },
      module.status === "failed" ? `${module.reason ?? ""} (see logs/${module.module}.log and logs/run.log)` : module.reason,
    ]),
    [],
    [{ value: "New: not in the baseline. Known: in the baseline. Accepted: covered by the project profile; the reason is in the Note column.", style: style.label }],
    [{ value: "Each module has its own sheet. The By rule sheet counts findings per rule (per package for dependency vulnerabilities).", style: style.label }],
  ];
  return { name: "Summary", widths: [44, 16, 12, 12, 12], rows };
}

interface RuleGroup {
  module: string;
  rule: string;
  title: string;
  severity: Severity;
  category: Finding["category"];
  rules: Set<string>;
  new: number;
  baseline: number;
  accepted: number;
}

// Builds the sheet that counts findings per rule, and per package for dependency findings.
function ruleSheet(result: RunResult): Sheet {
  const groups = new Map<string, RuleGroup>();
  for (const finding of result.findings) {
    const dependency = finding.category === "dependency";
    const name = dependency ? finding.title.replace(/: [^:]+$/, "") : finding.rule;
    const key = `${finding.module}\u0000${dependency ? "package" : "rule"}\u0000${name}`;
    const group = groups.get(key) ?? {
      module: finding.module,
      rule: finding.rule,
      title: dependency ? name : finding.title,
      severity: finding.severity,
      category: finding.category,
      rules: new Set<string>(),
      new: 0,
      baseline: 0,
      accepted: 0,
    };
    if (severityOrder.indexOf(finding.severity) < severityOrder.indexOf(group.severity)) group.severity = finding.severity;
    group.rules.add(finding.rule);
    group[finding.status ?? "new"]++;
    groups.set(key, group);
  }
  const total = (group: RuleGroup) => group.new + group.baseline + group.accepted;
  const items = [...groups.values()].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || total(b) - total(a) || a.module.localeCompare(b.module) || a.title.localeCompare(b.title),
  );
  return {
    name: "By rule",
    widths: [16, 34, 52, 11, 15, 8, 8, 10, 8],
    table: { headerRow: 0 },
    rows: [
      header("Module", "Rule", "Title", "Severity", "Category", "New", "Known", "Accepted", "Total"),
      ...items.map((group) => [
        group.module,
        { value: group.category === "dependency" ? `${group.rules.size} vulnerabilit${group.rules.size === 1 ? "y" : "ies"}` : group.rule, style: style.wrap },
        { value: group.title, style: style.wrap },
        severityCell(group.severity),
        categoryLabel[group.category],
        group.new,
        group.baseline,
        group.accepted,
        total(group),
      ]),
    ],
  };
}

// Builds the findings sheet of one module.
function moduleSheet(module: string, findings: Finding[]): Sheet {
  return {
    name: module,
    widths: [6, 10, 10, 38, 64, 48, 7, 52, 26, 14, 34, 40, 18],
    table: { headerRow: 0 },
    rows: [
      header("No", "Severity", "Status", "Title", "Details", "File", "Line", "Fix", "Rule", "Category", "Note", "References", "Fingerprint"),
      ...findings.map((finding, i) => [
        i + 1,
        severityCell(finding.severity),
        statusCell(finding),
        { value: finding.title, style: style.wrap },
        { value: finding.message, style: style.wrap },
        { value: finding.file, style: style.wrap },
        finding.line,
        { value: finding.hint, style: style.wrap },
        { value: finding.rule, style: style.wrap },
        categoryLabel[finding.category],
        { value: finding.note, style: style.wrap },
        { value: (finding.refs ?? []).join("\n"), style: style.wrap },
        finding.fingerprint,
      ]),
    ],
  };
}

// Builds the API inventory sheet from the endpoints module output.
function inventorySheet(result: RunResult): Sheet | null {
  const file = join(result.runDir, "raw", "endpoints.json");
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8")) as { endpoints: Endpoint[] };
  const order = ["none", "authenticated", "role", "public"];
  const items = [...data.endpoints].sort(
    (a, b) => order.indexOf(strength(a)) - order.indexOf(strength(b)) || a.path.localeCompare(b.path) || a.http.join().localeCompare(b.http.join()),
  );
  return {
    name: "API inventory",
    widths: [6, 10, 46, 24, 48, 10, 30, 26, 60, 7],
    table: { headerRow: 0 },
    rows: [
      header("No", "HTTP", "Path", "Protection", "Security annotation", "Declared on", "Controller", "Method", "File", "Line"),
      ...items.map((endpoint, i) => {
        const level = strength(endpoint);
        return [
          i + 1,
          endpoint.http.join(", "),
          { value: endpoint.path, style: style.wrap },
          { value: protection[level], style: level === "none" ? style.failed : level === "public" ? style.fresh : style.normal },
          { value: endpoint.public && !endpoint.security ? "permitAll in the security configuration" : endpoint.security, style: style.wrap },
          endpoint.securityLevel ?? "",
          endpoint.className,
          endpoint.method,
          { value: endpoint.file, style: style.wrap },
          endpoint.line,
        ];
      }),
    ],
  };
}

// Builds the Excel report of a run.
export function excel(result: RunResult): Uint8Array {
  const findings = sorted(result.findings);
  const sheets = [summarySheet(result), ruleSheet(result)];
  for (const module of result.modules) {
    const items = findings.filter((finding) => finding.module === module.module);
    if (items.length) sheets.push(moduleSheet(module.module, items));
  }
  const inventory = inventorySheet(result);
  if (inventory) sheets.push(inventory);
  return workbook(sheets);
}
