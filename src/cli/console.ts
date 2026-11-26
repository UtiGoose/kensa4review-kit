import { exec } from "../core/exec";
import { type RunResult, type Severity, severityLabel, severityOrder } from "../core/types";
import type { RunEvent } from "../core/runner";
import { count, duration } from "../report/summary";

const tty = process.stdout.isTTY;
const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

const severityColor: Record<Severity, (text: string) => string> = {
  critical: paint("1;31"),
  high: red,
  medium: yellow,
  low: cyan,
  info: dim,
};

let logged = false;

// Prints run progress events.
export function progress(event: RunEvent): void {
  if (event.type === "start") {
    logged = false;
    process.stdout.write(`${dim(`[${event.index + 1}/${event.total}]`)} ${event.module.title} … `);
  } else if (event.type === "log") {
    process.stdout.write(`${logged ? "" : "\n"}    ${dim(event.message)}\n`);
    logged = true;
  } else {
    const { result } = event;
    const prefix = logged ? "    " : "";
    if (result.status === "ok") console.log(`${prefix}${green("done")} ${result.count} findings (${duration(result.seconds)})`);
    else if (result.status === "skipped") console.log(`${prefix}${dim(`skipped: ${result.reason}`)}`);
    else console.log(`${prefix}${red("failed")}: ${result.reason}`);
  }
}

// Prints the totals of a finished run.
export function printSummary(result: RunResult, report: string): void {
  const counts = count(result.findings);
  console.log("");
  console.log(bold("Result"));
  for (const severity of severityOrder) {
    const item = counts.bySeverity[severity];
    if (!item.new && !item.baseline && !item.accepted) continue;
    console.log(`  ${severityColor[severity](severityLabel[severity].padEnd(9))} new ${item.new}  known ${item.baseline}  accepted ${item.accepted}`);
  }
  console.log(`  ${"Total".padEnd(9)} new ${counts.total.new}  known ${counts.total.baseline}  accepted ${counts.total.accepted}`);
  const failed = result.modules.filter((module) => module.status === "failed");
  if (failed.length) console.log(red(`  Failed modules: ${failed.map((module) => module.module).join(", ")} (see the logs folder)`));
  console.log("");
  console.log(`Report: ${report}`);
}

// Opens a file with the default application.
export async function openFile(path: string): Promise<void> {
  if (process.platform === "win32") await exec("cmd", ["/c", "start", "", path]);
  else if (process.platform === "darwin") await exec("open", [path]);
  else await exec("xdg-open", [path]);
}
