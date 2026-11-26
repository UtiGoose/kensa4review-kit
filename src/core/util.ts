import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Hashes the parts into a short stable fingerprint.
export function fingerprint(...parts: (string | number | undefined)[]): string {
  return createHash("sha1").update(parts.map((part) => String(part ?? "")).join("\u0000")).digest("hex").slice(0, 16);
}

// Converts a path to forward slashes.
export function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

// Converts a glob (**, *, ?) to a regular expression.
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  const text = posix(glob).replace(/^\.\//, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "*") {
      if (text[i + 1] === "*") {
        pattern += ".*";
        i++;
        if (text[i + 1] === "/") i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}(/.*)?$`);
}

// Returns true when the relative path matches one of the globs.
export function matchesAny(path: string, globs: string[]): boolean {
  const target = posix(path).replace(/^\.\//, "");
  return globs.some((glob) => globToRegExp(glob).test(target));
}

// Reads source lines of a project file, or an empty list.
export function sourceLines(root: string, file: string): string[] {
  try {
    return readFileSync(join(root, file), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

// Returns the normalized text of the given lines for fingerprints.
export function snippet(root: string, file: string, start: number, end = start): string {
  const lines = sourceLines(root, file).slice(Math.max(0, start - 1), Math.max(start, end));
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

// Makes a path relative to the project root when possible.
export function relativeTo(root: string, path: string): string {
  const normalizedRoot = posix(root).replace(/\/$/, "");
  const normalized = posix(path);
  if (normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized.replace(/^\/src\//, "").replace(/^\.\//, "");
}
