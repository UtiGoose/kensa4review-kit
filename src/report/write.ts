import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../core/types";
import { excel } from "./excel";

// Returns the report file name for a run.
export function reportName(result: RunResult): string {
  const date = new Date(result.startedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `review-${result.project.name.replace(/[^\w.-]+/g, "_")}-${time}.xlsx`;
}

// Writes the Excel report into the run folder and returns its path.
export function writeReports(result: RunResult): string {
  const file = join(result.runDir, reportName(result));
  writeFileSync(file, excel(result));
  return file;
}
