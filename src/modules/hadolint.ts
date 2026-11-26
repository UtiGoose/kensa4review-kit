import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dockerRun } from "../core/docker";
import { exec, hasCommand } from "../core/exec";
import type { CheckModule, Finding, Severity } from "../core/types";
import { fingerprint, snippet } from "../core/util";

export const hadolintModule: CheckModule = {
  id: "hadolint",
  title: "hadolint (Dockerfile)",
  modes: ["quick", "standard"],
  localTool: { command: "hadolint", args: ["--version"] },
  applies: (project) => (project.dockerfiles.length ? null : "no Dockerfile"),
  async run(ctx) {
    const local = ctx.runner !== "docker" && (await hasCommand("hadolint", ["--version"]));
    const findings: Finding[] = [];
    for (const file of ctx.project.dockerfiles) {
      const result = local
        ? await exec("hadolint", ["--format", "json", join(ctx.project.root, file)], { logFile: join(ctx.logDir, "hadolint.log") })
        : await dockerRun(ctx, ctx.tool.images.hadolint, ["hadolint", "--format", "json", `/src/${file}`], {
            log: "hadolint",
            mounts: [{ host: ctx.project.root, target: "/src", readOnly: true }],
          });
      const text = result.stdout.trim();
      if (!text.startsWith("[")) throw new Error(`cannot read hadolint output for ${basename(file)}`);
      writeFileSync(join(ctx.rawDir, `hadolint-${basename(file)}.json`), text);
      for (const item of JSON.parse(text)) {
        const severity: Severity = item.level === "error" ? "medium" : item.level === "warning" ? "low" : "info";
        findings.push({
          module: "hadolint",
          rule: item.code,
          title: item.code,
          severity,
          category: "config",
          message: item.message,
          file,
          line: item.line,
          refs: [`https://github.com/hadolint/hadolint/wiki/${item.code}`],
          fingerprint: fingerprint("hadolint", item.code, file, snippet(ctx.project.root, file, item.line)),
        });
      }
    }
    return findings;
  },
};
