import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../detect/detect";
import { modules } from "../modules";
import { dockerReady } from "./docker";
import { hasCommand } from "./exec";
import { classify, loadProfile, readBaseline } from "./profile";
import { fingerprint } from "./util";
import type { CheckModule, Context, Finding, Mode, ModuleResult, ProjectInfo, Profile, RunResult, ToolPaths } from "./types";

export interface RunOptions {
  mode: Mode;
  only?: string[];
  skip?: string[];
  runner: "auto" | "docker" | "local";
  offline: boolean;
  out: string;
  onEvent?: (event: RunEvent) => void;
}

export type RunEvent =
  | { type: "start"; module: CheckModule; index: number; total: number }
  | { type: "log"; module: CheckModule; message: string }
  | { type: "end"; module: CheckModule; result: ModuleResult };

// Loads the profile and detects the stack of a project.
export async function prepare(tool: ToolPaths, root: string): Promise<{ project: ProjectInfo; profile: Profile }> {
  const name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "project";
  const profile = loadProfile(tool, root, name);
  const project = await detect(root, profile.exclude);
  return { project, profile };
}

// Selects the modules to run for the mode and filters.
export function selectModules(mode: Mode, profile: Profile, only?: string[], skip?: string[]): CheckModule[] {
  return modules.filter((module) => {
    if (only?.length) return only.includes(module.id);
    if (!module.modes.includes(mode)) return false;
    return !profile.skip.includes(module.id) && !(skip ?? []).includes(module.id);
  });
}

// Decides whether a module can run, returning a skip reason otherwise.
async function blocker(module: CheckModule, ctx: Context): Promise<string | null> {
  const reason = module.applies(ctx.project);
  if (reason) return reason;
  if (!module.localTool) return null;
  if (ctx.runner !== "docker" && (await hasCommand(module.localTool.command, module.localTool.args))) return null;
  if (ctx.runner === "local") return `${module.localTool.command} is not installed`;
  return (await dockerReady()) ? null : "Docker is not running";
}

// Runs the selected modules and classifies their findings.
export async function runChecks(
  tool: ToolPaths,
  project: ProjectInfo,
  profile: Profile,
  selected: CheckModule[],
  options: RunOptions,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const runDir = options.out;
  const rawDir = join(runDir, "raw");
  const logDir = join(runDir, "logs");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const results: ModuleResult[] = [];
  const findings: Finding[] = [];
  for (const [index, module] of selected.entries()) {
    const ctx: Context = {
      project,
      profile,
      tool,
      runDir,
      rawDir,
      logDir,
      runner: options.runner,
      offline: options.offline,
      log: (message) => {
        appendFileSync(join(logDir, "run.log"), `[${module.id}] ${message}\n`);
        options.onEvent?.({ type: "log", module, message });
      },
    };
    options.onEvent?.({ type: "start", module, index, total: selected.length });
    const started = Date.now();
    let result: ModuleResult;
    const reason = await blocker(module, ctx);
    if (reason) {
      result = { module: module.id, title: module.title, status: "skipped", reason, seconds: 0, count: 0 };
    } else {
      try {
        const items = await module.run(ctx);
        findings.push(...items);
        result = { module: module.id, title: module.title, status: "ok", seconds: (Date.now() - started) / 1000, count: items.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendFileSync(join(logDir, "run.log"), `[${module.id}] ${error instanceof Error ? error.stack : message}\n`);
        result = { module: module.id, title: module.title, status: "failed", reason: message, seconds: (Date.now() - started) / 1000, count: 0 };
      }
    }
    results.push(result);
    options.onEvent?.({ type: "end", module, result });
  }
  const unique = distinct(findings);
  for (const result of results) if (result.status === "ok") result.count = unique.filter((finding) => finding.module === result.module).length;
  return {
    project,
    profile,
    mode: options.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    runDir,
    modules: results,
    findings: classify(unique, profile, readBaseline(profile)),
  };
}

// Drops exact duplicates and numbers repeated fingerprints in the same file.
export function distinct(findings: Finding[]): Finding[] {
  const ordered = [...findings].sort(
    (a, b) => a.module.localeCompare(b.module) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0),
  );
  const seen = new Set<string>();
  const occurrences = new Map<string, number>();
  const result: Finding[] = [];
  for (const finding of ordered) {
    const key = `${finding.fingerprint}:${finding.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = occurrences.get(finding.fingerprint) ?? 0;
    occurrences.set(finding.fingerprint, index + 1);
    result.push(index ? { ...finding, fingerprint: fingerprint(finding.fingerprint, index) } : finding);
  }
  return result;
}
