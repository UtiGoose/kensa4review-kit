import { basename } from "node:path";
import { exec } from "../core/exec";
import type { CheckModule, Finding } from "../core/types";
import { fingerprint } from "../core/util";

interface Change {
  commit: string;
  date: string;
  status: string;
  file: string;
}

const versionOf = (file: string) => basename(file).match(/^V(\d+(?:[._]\d+)*)__/)?.[1]?.replace(/_/g, ".");

// Reads the git history of a migration folder.
async function history(root: string, dir: string): Promise<Change[]> {
  const result = await exec(
    "git",
    ["-c", "safe.directory=*", "log", "--format=@%H%x09%ad", "--date=short", "--name-status", "--no-renames", "--", dir],
    { cwd: root, timeoutSec: 120 },
  );
  const changes: Change[] = [];
  let commit = "";
  let date = "";
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("@")) {
      [commit, date] = line.slice(1).split("\t");
    } else if (/^[AMD]\t/.test(line)) {
      const [status, file] = line.split("\t");
      changes.push({ commit, date, status, file });
    }
  }
  return changes.reverse();
}

export const flywayModule: CheckModule = {
  id: "flyway",
  title: "Flyway migrations",
  modes: ["quick", "standard"],
  applies: (project) =>
    !project.migrations.length ? "no migrations" : !project.git ? "not a git repository" : null,
  async run(ctx) {
    if (ctx.profile.flywayPolicy === "off") return [];
    const { root, files } = ctx.project;
    const findings: Finding[] = [];
    for (const dir of ctx.project.migrations) {
      const current = files.filter((file) => file.startsWith(`${dir}/`) && versionOf(file));
      const changes = await history(root, dir);
      const versions = new Map<string, string[]>();
      for (const file of current) {
        const version = versionOf(file) ?? "";
        versions.set(version, [...(versions.get(version) ?? []), file]);
        const own = changes.filter((change) => change.file === file);
        const added = own.findIndex((change) => change.status === "A");
        const modified = own.slice(added + 1).filter((change) => change.status === "M");
        if (added >= 0 && modified.length) {
          const last = modified[modified.length - 1];
          findings.push({
            module: "flyway",
            rule: "modified-migration",
            title: "Existing migration was modified",
            severity: "medium",
            category: "config",
            message: `${basename(file)} was changed ${modified.length} time(s) after it was added (last ${last.date}, ${last.commit.slice(0, 7)}). Databases that already applied it fail to start with a checksum mismatch.`,
            hint: "Leave applied migrations unchanged and add a new versioned migration instead.",
            file,
            fingerprint: fingerprint("flyway", "modified", file, last.commit),
          });
        }
      }
      for (const [version, items] of versions) {
        if (items.length > 1) {
          findings.push({
            module: "flyway",
            rule: "duplicate-version",
            title: "Duplicate migration version",
            severity: "high",
            category: "config",
            message: `V${version} is used by ${items.map((item) => basename(item)).join(", ")}.`,
            file: items[0],
            fingerprint: fingerprint("flyway", "duplicate", version, ...items),
          });
        }
      }
      const deleted = [...new Set(
        changes
          .filter((change) => change.status === "D" && versionOf(change.file) && !current.includes(change.file))
          .map((change) => change.file),
      )].sort();
      if (deleted.length) {
        const last = changes.filter((change) => change.status === "D").pop();
        const names = deleted.map((file) => basename(file));
        findings.push({
          module: "flyway",
          rule: "deleted-migration",
          title: "Deleted migrations",
          severity: "medium",
          category: "config",
          message: `${deleted.length} migration(s) were deleted from ${dir} (for example ${names.slice(0, 5).join(", ")}${deleted.length > 5 ? ", …" : ""}; last on ${last?.date ?? ""}). Databases that applied them no longer match the history.`,
          hint: "If they were squashed on purpose, document the baseline or repair steps for existing databases.",
          file: dir,
          fingerprint: fingerprint("flyway", "deleted", dir, ...deleted),
        });
      }
      const status = await exec("git", ["-c", "safe.directory=*", "status", "--porcelain", "--", dir], { cwd: root, timeoutSec: 60 });
      for (const line of status.stdout.split(/\r?\n/)) {
        const match = line.match(/^ ?M\s+(.+)$/) ?? line.match(/^M.\s+(.+)$/);
        if (match && versionOf(match[1])) {
          findings.push({
            module: "flyway",
            rule: "uncommitted-change",
            title: "Uncommitted migration change",
            severity: "medium",
            category: "config",
            message: `${basename(match[1])} has uncommitted changes.`,
            file: match[1].trim(),
            fingerprint: fingerprint("flyway", "uncommitted", match[1].trim()),
          });
        }
      }
    }
    return findings;
  },
};
