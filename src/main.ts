import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs, usage } from "./cli/args";
import { bold, dim, green, openFile, printSummary, progress, red, yellow } from "./cli/console";
import { dockerReady } from "./core/docker";
import { exec, hasCommand } from "./core/exec";
import { readState, rememberProject, stamp, toolPaths } from "./core/paths";
import { writeBaseline } from "./core/profile";
import { prepare, runChecks, selectModules } from "./core/runner";
import { atLeast, type Mode, type RunResult, type ToolPaths } from "./core/types";
import { describe } from "./detect/detect";
import { modules } from "./modules";
import { writeReports } from "./report/write";

// Returns true when the folder looks like a source project.
function looksLikeProject(dir: string): boolean {
  return [".git", "build.gradle.kts", "build.gradle", "pom.xml", "package.json"].some((name) => existsSync(join(dir, name)));
}

// Lists candidate projects from recent runs and their sibling folders.
function candidates(tool: ToolPaths): string[] {
  const recent = readState(tool.home).recent.filter((dir) => existsSync(dir));
  const found = new Set(recent);
  for (const parent of new Set(recent.map((dir) => dirname(dir)))) {
    try {
      for (const name of readdirSync(parent)) {
        const dir = join(parent, name);
        if (found.size >= 20) break;
        if (statSync(dir).isDirectory() && looksLikeProject(dir)) found.add(dir);
      }
    } catch {
      continue;
    }
  }
  return [...found];
}

// Decides the exit code from the fail-on condition.
function exitCode(result: RunResult, failOn: string): number {
  const open = result.findings.filter((finding) => finding.status !== "accepted");
  const fresh = open.filter((finding) => finding.status === "new");
  if (failOn === "new-high") return fresh.some((finding) => atLeast(finding.severity, "high")) ? 1 : 0;
  if (failOn === "new-medium") return fresh.some((finding) => atLeast(finding.severity, "medium")) ? 1 : 0;
  if (failOn === "high") return open.some((finding) => atLeast(finding.severity, "high")) ? 1 : 0;
  return 0;
}

// Runs the checks for a project and writes the reports.
async function execute(tool: ToolPaths, root: string, mode: Mode, options: { only?: string[]; skip?: string[]; out?: string; runner: "auto" | "docker" | "local"; offline: boolean }) {
  const { project, profile } = await prepare(tool, root);
  const selected = selectModules(mode, profile, options.only, options.skip);
  const out = resolve(options.out ?? join(tool.home, "runs", project.name, stamp()));
  rememberProject(tool.home, root);
  const result = await runChecks(tool, project, profile, selected, { mode, runner: options.runner, offline: options.offline, out, only: options.only, skip: options.skip, onEvent: progress });
  const report = writeReports(result);
  printSummary(result, report);
  return { result, report, profile };
}

// Runs the interactive flow.
async function interactive(tool: ToolPaths): Promise<number> {
  console.log(bold("kensa  security and performance review"));
  const list = candidates(tool);
  let root: string;
  if (list.length) {
    const choice = await select({
      message: "Project to check",
      choices: [...list.map((dir) => ({ name: dir, value: dir })), { name: "Enter a folder path…", value: "" }],
    });
    root = choice || (await input({ message: "Folder path", default: process.cwd() }));
  } else {
    root = await input({ message: "Folder to check", default: process.cwd() });
  }
  root = resolve(root.trim().replace(/^"|"$/g, ""));
  if (!existsSync(root)) {
    console.log(red(`Folder not found: ${root}`));
    return 2;
  }
  const { project, profile } = await prepare(tool, root);
  console.log("");
  console.log(bold(`${project.name}`) + dim(`  ${root}`));
  for (const line of describe(project)) console.log(`  ${line}`);
  console.log(dim(`  Project profile: ${profile.source ?? "none (defaults)"}`));
  console.log("");
  const mode = await select<string>({
    message: "Scope",
    choices: [
      { name: "Standard: all checks, including Gradle-based analysis", value: "standard" },
      { name: "Quick:    checks that need no build (a few minutes)", value: "quick" },
      { name: "Custom:   choose modules", value: "custom" },
    ],
  });
  let only: string[] | undefined;
  if (mode === "custom") {
    only = await checkbox({
      message: "Modules to run",
      choices: modules.map((module) => {
        const reason = module.applies(project);
        return { name: reason ? `${module.title} (${reason})` : module.title, value: module.id, checked: !reason, disabled: Boolean(reason) };
      }),
    });
  }
  const selected = selectModules(mode === "quick" ? "quick" : "standard", profile, only);
  if (selected.some((module) => module.localTool && !module.applies(project)) && !(await dockerReady())) {
    console.log(yellow("Docker is not running. Modules that need Docker will be skipped."));
    if (!(await confirm({ message: "Continue anyway?", default: false }))) return 1;
  }
  console.log("");
  const { result, report } = await execute(tool, root, mode === "quick" ? "quick" : "standard", { only, runner: "auto", offline: false });
  if (await confirm({ message: "Open the report?", default: true })) await openFile(report);
  const hasBaseline = existsSync(join(profile.dir, "baseline.json"));
  const question = hasBaseline ? "Update the baseline with this result?" : "Save this result as the baseline? (later runs mark only new findings as New)";
  if (await confirm({ message: question, default: false })) console.log(green(`Saved: ${writeBaseline(result.profile, result.findings)}`));
  return 0;
}

// Checks that the external tools can run.
async function doctor(tool: ToolPaths): Promise<number> {
  const docker = await dockerReady();
  console.log(`${docker ? green("OK ") : red("NG ")} Docker${docker ? "" : " (start Docker Desktop)"}`);
  const git = await hasCommand("git", ["--version"]);
  console.log(`${git ? green("OK ") : red("NG ")} git`);
  const java = await hasCommand("java", ["-version"]);
  console.log(`${java ? green("OK ") : yellow("-- ")} java${java ? "" : " (Gradle-based checks need a JDK that can build the project)"}`);
  if (docker) {
    for (const [name, image] of Object.entries(tool.images)) {
      const result = await exec("docker", ["image", "inspect", image], { timeoutSec: 30 });
      console.log(`${result.code === 0 ? green("OK ") : dim("-- ")} ${name}: ${image}${result.code === 0 ? "" : " (pulled on first use)"}`);
    }
  }
  console.log(dim(`Tool folder: ${tool.root}`));
  console.log(dim(`Data folder: ${tool.home}`));
  return docker && git ? 0 : 1;
}

// Entry point.
async function main(): Promise<number> {
  process.env.SEMGREP_ENABLE_VERSION_CHECK ??= "0";
  process.env.SEMGREP_SEND_METRICS ??= "off";
  const args = parseArgs(process.argv.slice(2));
  const tool = toolPaths();
  switch (args.command) {
    case "":
      return interactive(tool);
    case "run": {
      if (!args.project) {
        console.log(usage);
        return 2;
      }
      const root = resolve(args.project);
      if (!existsSync(root)) {
        console.log(red(`Folder not found: ${root}`));
        return 2;
      }
      const mode: Mode = args.mode === "quick" ? "quick" : "standard";
      const { result, report } = await execute(tool, root, mode, args);
      if (args.updateBaseline) console.log(green(`Baseline saved: ${writeBaseline(result.profile, result.findings)}`));
      if (args.open) await openFile(report);
      return exitCode(result, args.failOn);
    }
    case "modules":
      for (const module of modules) console.log(`${module.id.padEnd(14)} ${module.title}  ${dim(module.modes.includes("quick") ? "quick, standard" : "standard")}`);
      return 0;
    case "doctor":
      return doctor(tool);
    default:
      console.log(usage);
      return args.command === "help" ? 0 : 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error?.name === "ExitPromptError") process.exit(130);
    console.error(red(error instanceof Error ? error.message : String(error)));
    process.exit(2);
  });
