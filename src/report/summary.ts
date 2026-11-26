import { type Finding, type Severity, severityOrder } from "../core/types";

export interface Counts {
  bySeverity: Record<Severity, { new: number; baseline: number; accepted: number }>;
  total: { new: number; baseline: number; accepted: number };
}

// Counts findings by severity and status.
export function count(findings: Finding[]): Counts {
  const bySeverity = Object.fromEntries(severityOrder.map((severity) => [severity, { new: 0, baseline: 0, accepted: 0 }])) as Counts["bySeverity"];
  const total = { new: 0, baseline: 0, accepted: 0 };
  for (const finding of findings) {
    const status = finding.status ?? "new";
    bySeverity[finding.severity][status]++;
    total[status]++;
  }
  return { bySeverity, total };
}

// Sorts findings by severity, module, file and line.
export function sorted(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) ||
      a.module.localeCompare(b.module) ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

// Formats seconds as a short duration.
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
