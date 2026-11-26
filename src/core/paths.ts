import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ToolPaths } from "./types";

// Finds the tool root (the folder with tools.lock.json).
function findRoot(): string {
  const fromEnv = process.env.KENSA_HOME;
  if (fromEnv && existsSync(join(fromEnv, "tools.lock.json"))) return resolve(fromEnv);
  const starts = [dirname(process.execPath), import.meta.dir, process.cwd()];
  for (const start of starts) {
    let current = resolve(start);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(current, "tools.lock.json"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("tools.lock.json not found. Set KENSA_HOME to the kensa folder.");
}

// Loads the tool locations and pinned versions.
export function toolPaths(): ToolPaths {
  const root = findRoot();
  const lock = JSON.parse(readFileSync(join(root, "tools.lock.json"), "utf8"));
  const home = process.env.KENSA_DATA ?? join(homedir(), ".kensa");
  mkdirSync(home, { recursive: true });
  return { root, home, images: lock.images, gradle: lock.gradle };
}

interface State {
  recent: string[];
}

// Reads the list of recently checked projects.
export function readState(home: string): State {
  const file = join(home, "state.json");
  if (!existsSync(file)) return { recent: [] };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { recent: [] };
  }
}

// Remembers a project as the most recent one.
export function rememberProject(home: string, project: string): void {
  const state = readState(home);
  state.recent = [project, ...state.recent.filter((item) => item !== project)].slice(0, 10);
  writeFileSync(join(home, "state.json"), JSON.stringify(state, null, 2));
}

// Formats a timestamp for run folder names.
export function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
