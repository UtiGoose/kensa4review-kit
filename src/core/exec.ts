import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  logFile?: string;
  timeoutSec?: number;
}

// Runs a command and collects its output.
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (options.logFile) appendFileSync(options.logFile, `$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutSec
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutSec * 1000)
      : null;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.logFile) appendFileSync(options.logFile, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.logFile) appendFileSync(options.logFile, chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (options.logFile) appendFileSync(options.logFile, `\n[exit ${code}]\n`);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// Returns true when the command can be started.
export async function hasCommand(command: string, args = ["--version"]): Promise<boolean> {
  const result = await exec(command, args, { timeoutSec: 30 });
  return result.code === 0;
}
