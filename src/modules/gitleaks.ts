import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerRun, gitSafeEnv } from "../core/docker";
import { exec, hasCommand } from "../core/exec";
import type { CheckModule, Finding } from "../core/types";
import { fingerprint } from "../core/util";

interface Leak {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  Commit: string;
  Date: string;
  Fingerprint: string;
}

export const gitleaksModule: CheckModule = {
  id: "gitleaks",
  title: "gitleaks (secrets in the full git history)",
  modes: ["quick", "standard"],
  localTool: { command: "gitleaks", args: ["version"] },
  applies: (project) => (project.git ? null : "not a git repository"),
  async run(ctx) {
    const config = join(ctx.profile.dir, "gitleaks.toml");
    const hasConfig = existsSync(config);
    const output = join(ctx.rawDir, "gitleaks.json");
    const common = ["--report-format", "json", "--redact", "--no-banner", "--exit-code", "0", "--log-level", "warn"];
    if (ctx.runner !== "docker" && (await hasCommand("gitleaks", ["version"]))) {
      await exec("gitleaks", ["git", ctx.project.root, "--report-path", output, ...common, ...(hasConfig ? ["--config", config] : [])], {
        logFile: join(ctx.logDir, "gitleaks.log"),
        env: gitSafeEnv,
        timeoutSec: 3600,
      });
    } else {
      const mounts = [
        { host: ctx.project.root, target: "/src", readOnly: true },
        { host: ctx.rawDir, target: "/out" },
      ];
      if (hasConfig) mounts.push({ host: ctx.profile.dir, target: "/config", readOnly: true });
      await dockerRun(ctx, ctx.tool.images.gitleaks, ["git", "/src", "--report-path", "/out/gitleaks.json", ...common, ...(hasConfig ? ["--config", "/config/gitleaks.toml"] : [])], {
        log: "gitleaks",
        env: gitSafeEnv,
        mounts,
      });
    }
    if (!existsSync(output)) throw new Error("gitleaks produced no report (see the logs)");
    const leaks = JSON.parse(readFileSync(output, "utf8") || "[]") as Leak[];
    return leaks.map((leak) => ({
      module: "gitleaks",
      rule: leak.RuleID,
      title: `Possible secret: ${leak.RuleID}`,
      severity: "high",
      category: "secret",
      message: `${leak.Description} in ${leak.File}:${leak.StartLine}, commit ${leak.Commit.slice(0, 7)} (${leak.Date.slice(0, 10)}).`,
      hint: "If it is a real credential, revoke and rotate it. If it is intended, record the reason in the accepted list.",
      file: leak.File,
      line: leak.StartLine,
      fingerprint: fingerprint("gitleaks", leak.Fingerprint),
    }));
  },
};
