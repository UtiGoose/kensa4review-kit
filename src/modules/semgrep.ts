import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerRun, gitSafeEnv } from "../core/docker";
import { exec, hasCommand } from "../core/exec";
import type { Category, CheckModule, Context, Finding, Severity } from "../core/types";
import { fingerprint, relativeTo, snippet } from "../core/util";

const testExclude = ["**/src/test/**", "**/src/integrationTest/**", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/__tests__/**"];

// Chooses the registry rule packs for the detected stack.
function registryPacks(ctx: Context): string[] {
  if (ctx.offline) return [];
  if (ctx.profile.semgrepRegistry) return ctx.profile.semgrepRegistry;
  const packs: string[] = [];
  if (ctx.project.javaSources.length) packs.push("p/java");
  if (ctx.project.node.length) packs.push("p/javascript", "p/typescript");
  if (ctx.project.node.some((node) => node.frameworks.includes("react"))) packs.push("p/react");
  if (packs.length) packs.push("p/owasp-top-ten");
  return packs;
}

// Maps semgrep severity and metadata to the report severity.
function severityOf(level: string): Severity {
  switch (level.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "ERROR":
    case "HIGH":
      return "high";
    case "WARNING":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "info";
  }
}

// Maps the rule category metadata to the report category.
function categoryOf(metadata: Record<string, unknown>): Category {
  const value = String(metadata.category ?? "").toLowerCase();
  if (value === "security") return "security";
  if (value === "performance") return "performance";
  return "quality";
}

// Runs semgrep once with the given rule configs.
async function scan(ctx: Context, configs: string[], local: boolean): Promise<boolean> {
  const output = join(ctx.rawDir, "semgrep.json");
  const excludes = [...ctx.profile.exclude, ...testExclude].flatMap((glob) => ["--exclude", glob]);
  const common = ["scan", "--metrics=off", "--disable-version-check", "--json", "--timeout", "30", "--max-target-bytes", "2000000", ...excludes];
  if (local) {
    const args = [...common, "--output", output, ...configs.flatMap((config) => ["--config", config.replace("/rules", join(ctx.tool.root, "rules/semgrep"))]), ctx.project.root];
    await exec("semgrep", args, { logFile: join(ctx.logDir, "semgrep.log"), timeoutSec: 3600, env: gitSafeEnv });
  } else {
    const args = ["semgrep", ...common, "--output", "/out/semgrep.json", ...configs.flatMap((config) => ["--config", config]), "/src"];
    await dockerRun(ctx, ctx.tool.images.semgrep, args, {
      log: "semgrep",
      env: { ...gitSafeEnv, SEMGREP_ENABLE_VERSION_CHECK: "0", SEMGREP_SEND_METRICS: "off" },
      workdir: "/src",
      mounts: [
        { host: ctx.project.root, target: "/src", readOnly: true },
        { host: join(ctx.tool.root, "rules/semgrep"), target: "/rules", readOnly: true },
        { host: ctx.rawDir, target: "/out" },
      ],
    });
  }
  return existsSync(output);
}

export const semgrepModule: CheckModule = {
  id: "semgrep",
  title: "Semgrep (source code analysis)",
  modes: ["quick", "standard"],
  localTool: { command: "semgrep", args: ["--version"] },
  applies: (project) => (project.javaSources.length || project.node.length ? null : "no supported sources"),
  async run(ctx) {
    const local = ctx.runner !== "docker" && (await hasCommand("semgrep"));
    const packs = registryPacks(ctx);
    let ok = await scan(ctx, ["/rules", ...packs], local);
    if (!ok && packs.length) {
      ctx.log("Registry rules could not be loaded; running the bundled rules only");
      ok = await scan(ctx, ["/rules"], local);
    }
    if (!ok) throw new Error("Semgrep produced no report (see the logs)");
    const data = JSON.parse(readFileSync(join(ctx.rawDir, "semgrep.json"), "utf8"));
    if (data.errors?.length) ctx.log(`${data.errors.length} parse errors`);
    return (data.results ?? []).map((result: any): Finding => {
      const file = relativeTo(ctx.project.root, result.path);
      const metadata = result.extra?.metadata ?? {};
      const rule = String(result.check_id).split(".").pop() ?? result.check_id;
      const cwe = ([] as string[]).concat(metadata.cwe ?? []).map((item) => String(item).split(":")[0]);
      return {
        module: "semgrep",
        rule,
        title: String(metadata.title ?? rule),
        severity: severityOf(result.extra?.severity ?? "INFO"),
        category: categoryOf(metadata),
        message: String(result.extra?.message ?? "").trim(),
        file,
        line: result.start?.line,
        refs: [...cwe, ...([] as string[]).concat(metadata.references ?? []).slice(0, 2)],
        fingerprint: fingerprint("semgrep", rule, file, snippet(ctx.project.root, file, result.start?.line ?? 0, result.end?.line ?? 0)),
      };
    });
  },
};
