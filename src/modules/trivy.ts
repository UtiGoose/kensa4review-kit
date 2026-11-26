import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { dockerRun } from "../core/docker";
import { exec, hasCommand } from "../core/exec";
import type { CheckModule, Context, Finding, Severity } from "../core/types";
import { fingerprint, matchesAny, relativeTo } from "../core/util";

// Maps a Trivy severity to the report severity.
function severityOf(value: string): Severity {
  return ({ CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" } as Record<string, Severity>)[value] ?? "info";
}

// Runs Trivy with the arguments and returns true when the report exists.
export async function runTrivy(ctx: Context, args: string[], output: string, source = ctx.project.root): Promise<boolean> {
  const cache = join(ctx.tool.home, "cache", "trivy");
  mkdirSync(cache, { recursive: true });
  const target = join(ctx.rawDir, output);
  if (ctx.runner !== "docker" && (await hasCommand("trivy", ["--version"]))) {
    const localArgs = args.map((arg) => arg.replace(/^\/src/, source).replace(/^\/out/, ctx.rawDir));
    await exec("trivy", [...localArgs, "--cache-dir", cache, "--format", "json", "--output", target, "--timeout", "30m", "--quiet"], {
      logFile: join(ctx.logDir, `trivy-${output}.log`),
      timeoutSec: 3600,
    });
  } else {
    const mounts = [
      { host: source, target: "/src", readOnly: true },
      { host: ctx.rawDir, target: "/out" },
      { host: process.platform === "linux" ? cache : "kensa-trivy-cache", target: "/cache" },
    ];
    await dockerRun(ctx, ctx.tool.images.trivy, [...args, "--cache-dir", "/cache", "--format", "json", "--output", `/out/${output}`, "--timeout", "30m", "--quiet"], {
      log: `trivy-${output}`,
      mounts,
      timeoutSec: 3600,
    });
  }
  return existsSync(target);
}

// Converts a Trivy JSON report into findings.
export function trivyFindings(ctx: Context, module: string, report: any, targetOverride?: string): Finding[] {
  const findings: Finding[] = [];
  for (const result of report.Results ?? []) {
    const target = targetOverride ?? relativeTo(ctx.project.root, String(result.Target ?? ""));
    for (const vuln of result.Vulnerabilities ?? []) {
      findings.push({
        module,
        rule: vuln.VulnerabilityID,
        title: `${vuln.PkgName} ${vuln.InstalledVersion}: ${vuln.VulnerabilityID}`,
        severity: severityOf(vuln.Severity),
        category: "dependency",
        message: vuln.Title ?? vuln.Description?.slice(0, 200) ?? vuln.VulnerabilityID,
        hint: vuln.FixedVersion ? `Upgrade to ${vuln.FixedVersion} or later.` : "No fixed version yet. Assess whether the vulnerable code is reachable.",
        file: target,
        refs: vuln.PrimaryURL ? [vuln.PrimaryURL] : [],
        fingerprint: fingerprint(module, vuln.VulnerabilityID, vuln.PkgName, vuln.InstalledVersion, target),
      });
    }
    for (const item of result.Misconfigurations ?? []) {
      if (item.Status && item.Status !== "FAIL") continue;
      findings.push({
        module,
        rule: item.ID ?? item.AVDID,
        title: item.Title ?? item.ID,
        severity: severityOf(item.Severity),
        category: "config",
        message: item.Message ?? item.Description ?? "",
        hint: item.Resolution,
        file: target,
        line: item.CauseMetadata?.StartLine || undefined,
        refs: item.PrimaryURL ? [item.PrimaryURL] : [],
        fingerprint: fingerprint(module, item.ID ?? item.AVDID, target, item.Message),
      });
    }
  }
  return findings;
}

// Copies the lockfiles into the run folder, so Trivy does not walk the whole project.
function stageLockfiles(ctx: Context): string {
  const stage = join(ctx.rawDir, "lockfiles");
  rmSync(stage, { recursive: true, force: true });
  for (const node of ctx.project.node) {
    if (matchesAny(node.dir, ctx.profile.exclude)) continue;
    for (const file of [...node.lockfiles, node.dir ? `${node.dir}/package.json` : "package.json"]) {
      const from = join(ctx.project.root, file);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      copyFileSync(from, join(stage, file));
    }
  }
  return stage;
}

export const trivyModule: CheckModule = {
  id: "trivy",
  title: "Trivy (npm dependency vulnerabilities)",
  modes: ["quick", "standard"],
  localTool: { command: "trivy", args: ["--version"] },
  applies: (project) =>
    project.node.some((node) => node.lockfiles.length) ? null : "no npm, bun, pnpm or yarn lockfile",
  async run(ctx) {
    const ok = await runTrivy(ctx, ["fs", "--scanners", "vuln", "/src"], "trivy-fs.json", stageLockfiles(ctx));
    if (!ok) throw new Error("Trivy produced no report (see the logs)");
    return trivyFindings(ctx, "trivy", JSON.parse(readFileSync(join(ctx.rawDir, "trivy-fs.json"), "utf8")));
  },
};
