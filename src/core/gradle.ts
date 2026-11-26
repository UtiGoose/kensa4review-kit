import { join } from "node:path";
import { exec, type ExecResult } from "./exec";
import type { Context } from "./types";

// Runs the project's Gradle wrapper with a kensa init script.
export function runGradle(
  ctx: Context,
  initScript: string,
  tasks: string[],
  properties: Record<string, string>,
  log: string,
): Promise<ExecResult> {
  const script = join(ctx.tool.root, "rules", "gradle", initScript);
  const args = [
    "--init-script",
    script,
    ...Object.entries(properties).map(([key, value]) => `-D${key}=${value}`),
    ...tasks,
    "--continue",
    "--no-configuration-cache",
    "--console=plain",
  ];
  const windows = process.platform === "win32";
  const command = windows ? "cmd" : "sh";
  const commandArgs = windows ? ["/c", "gradlew.bat", ...args] : ["gradlew", ...args];
  return exec(command, commandArgs, {
    cwd: ctx.project.root,
    logFile: join(ctx.logDir, `${log}.log`),
    timeoutSec: 3600,
  });
}
