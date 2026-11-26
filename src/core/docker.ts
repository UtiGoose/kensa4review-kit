import { join } from "node:path";
import { exec, type ExecResult } from "./exec";
import type { Context } from "./types";

export interface Mount {
  host: string;
  target: string;
  readOnly?: boolean;
}

export interface DockerOptions {
  mounts: Mount[];
  env?: Record<string, string>;
  log: string;
  workdir?: string;
  timeoutSec?: number;
}

export const gitSafeEnv: Record<string, string> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
};

let dockerState: boolean | null = null;

// Checks once whether the Docker daemon answers.
export async function dockerReady(): Promise<boolean> {
  if (dockerState === null) {
    const result = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutSec: 30 });
    dockerState = result.code === 0 && result.stdout.trim().length > 0;
  }
  return dockerState;
}

// Runs an image with the given mounts and arguments.
export async function dockerRun(
  ctx: Context,
  image: string,
  args: string[],
  options: DockerOptions,
): Promise<ExecResult> {
  const command = ["run", "--rm"];
  if (process.platform === "linux" && typeof process.getuid === "function") {
    command.push("--user", `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`);
  }
  command.push("-e", "HOME=/tmp");
  for (const [key, value] of Object.entries(options.env ?? {})) command.push("-e", `${key}=${value}`);
  for (const mount of options.mounts) {
    command.push("-v", `${mount.host}:${mount.target}${mount.readOnly ? ":ro" : ""}`);
  }
  if (options.workdir) command.push("-w", options.workdir);
  command.push(image, ...args);
  return exec("docker", command, {
    logFile: join(ctx.logDir, `${options.log}.log`),
    timeoutSec: options.timeoutSec ?? 1800,
  });
}
