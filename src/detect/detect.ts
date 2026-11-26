import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exec } from "../core/exec";
import type { NodeProject, ProjectInfo } from "../core/types";
import { matchesAny, posix } from "../core/util";

const walkSkip = new Set(["node_modules", ".git", "build", "dist", "target", ".gradle", ".idea", ".venv"]);

// Lists project files, using git when available so ignored files are skipped.
async function listFiles(root: string): Promise<{ files: string[]; git: boolean }> {
  if (existsSync(join(root, ".git"))) {
    const result = await exec("git", ["-c", "safe.directory=*", "ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root,
      timeoutSec: 120,
    });
    if (result.code === 0) {
      const files = result.stdout.split("\0").filter(Boolean).map(posix);
      return { files: files.filter((file) => existsSync(join(root, file))), git: true };
    }
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!walkSkip.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  walk("");
  return { files, git: false };
}

// Reads a project file, or returns an empty string.
function read(root: string, file: string): string {
  try {
    if (statSync(join(root, file)).size > 2_000_000) return "";
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
}

// Returns the unique module folders that hold src/main/java.
function javaModules(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const index = file.indexOf("src/main/java/");
    if (index >= 0 && file.endsWith(".java")) dirs.add(file.slice(0, index).replace(/\/$/, ""));
  }
  return [...dirs].sort();
}

// Finds the Java version from common build files.
function javaVersion(root: string, files: string[]): string | undefined {
  const toml = read(root, "gradle/libs.versions.toml").match(/^\s*java\s*=\s*"(\d+)"/m);
  if (toml) return toml[1];
  for (const file of files.filter((item) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/.test(item))) {
    const text = read(root, file);
    const match =
      text.match(/JavaLanguageVersion\.of\((\d+)\)/) ??
      text.match(/<java\.version>(\d+)<\/java\.version>/) ??
      text.match(/<maven\.compiler\.release>(\d+)</) ??
      text.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/);
    if (match) return match[1];
  }
  return undefined;
}

// Finds the Spring Boot version from common build files.
function springBootVersion(root: string, files: string[]): string | undefined {
  const toml = read(root, "gradle/libs.versions.toml").match(/^\s*spring-?[bB]oot\s*=\s*"([\d.]+[\w.-]*)"/m);
  if (toml) return toml[1];
  for (const file of files.filter((item) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/.test(item))) {
    const text = read(root, file);
    const match =
      text.match(/org\.springframework\.boot["']?\)?\s*version\s*["']([\d.]+[\w.-]*)/) ??
      text.match(/spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)</);
    if (match) return match[1];
  }
  return undefined;
}

// Describes the Node projects found by package.json.
function nodeProjects(root: string, files: string[]): NodeProject[] {
  const fileSet = new Set(files);
  return files
    .filter((file) => basename(file) === "package.json")
    .map((file) => {
      const dir = dirname(file) === "." ? "" : posix(dirname(file));
      const prefix = dir ? `${dir}/` : "";
      const lockfiles = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]
        .filter((name) => fileSet.has(`${prefix}${name}`))
        .map((name) => `${prefix}${name}`);
      const manager = lockfiles[0]?.includes("bun")
        ? "bun"
        : lockfiles[0]?.includes("pnpm")
          ? "pnpm"
          : lockfiles[0]?.includes("yarn")
            ? "yarn"
            : lockfiles[0]
              ? "npm"
              : "unknown";
      let frameworks: string[] = [];
      try {
        const json = JSON.parse(read(root, file));
        const deps = { ...json.dependencies, ...json.devDependencies };
        frameworks = ["react", "vite", "next", "vue", "@angular/core", "svelte"].filter((name) => name in deps);
      } catch {
        frameworks = [];
      }
      return { dir, manager, lockfiles, frameworks } as NodeProject;
    });
}

// Detects the technology stack of a project.
export async function detect(root: string, exclude: string[]): Promise<ProjectInfo> {
  const listed = await listFiles(root);
  const files = listed.files.filter((file) => !matchesAny(file, exclude));
  const has = (name: string) => files.includes(name);
  const gradleRoot = ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"].some(has);
  const modules = javaModules(files);
  const nginxConfs = files.filter((file) => {
    if (!file.endsWith(".conf")) return false;
    const text = read(root, file);
    return /\bserver\s*\{/.test(text) && /\blocation\b/.test(text);
  });
  const migrationDirs = new Set<string>();
  for (const file of files) {
    if (/(^|\/)db\/migration(\/[^/]+)*\/V\d+(_\d+)*__[^/]+\.sql$/.test(file)) migrationDirs.add(posix(dirname(file)));
  }
  return {
    root,
    name: basename(root),
    files,
    git: listed.git,
    gradle: gradleRoot
      ? { wrapper: has("gradlew") || has("gradlew.bat") ? "gradlew" : null, javaDirs: modules }
      : undefined,
    maven: has("pom.xml") ? { javaDirs: modules } : undefined,
    javaVersion: javaVersion(root, files),
    springBoot: springBootVersion(root, files),
    springConfigs: files.filter((file) =>
      /(^|\/)src\/main\/resources\/application(-[\w-]+)?\.(ya?ml|properties)$/.test(file),
    ),
    javaSources: files.filter((file) => /(^|\/)src\/main\/java\/.+\.java$/.test(file)),
    node: nodeProjects(root, files),
    dockerfiles: files.filter((file) => /^(Dockerfile(\.[\w-]+)?|[\w.-]+\.dockerfile)$/i.test(basename(file))),
    composeFiles: files.filter((file) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(basename(file))),
    nginxConfs,
    migrations: [...migrationDirs].sort(),
  };
}

// Builds the one-line stack summary shown before a run.
export function describe(project: ProjectInfo): string[] {
  const lines: string[] = [];
  const java: string[] = [];
  if (project.gradle) java.push("Gradle");
  if (project.maven) java.push("Maven");
  if (project.javaVersion) java.push(`Java ${project.javaVersion}`);
  if (project.springBoot) java.push(`Spring Boot ${project.springBoot}`);
  if (java.length) lines.push(`${java.join(" · ")} (${project.javaSources.length} Java sources)`);
  if (project.migrations.length) lines.push(`Flyway migrations: ${project.migrations.join(", ")}`);
  for (const node of project.node) {
    const parts = [node.dir || "(root)", node.manager, ...node.frameworks];
    lines.push(`Node: ${parts.join(" · ")}`);
  }
  if (project.dockerfiles.length) lines.push(`Dockerfile: ${project.dockerfiles.join(", ")}`);
  if (project.composeFiles.length) lines.push(`Compose: ${project.composeFiles.join(", ")}`);
  if (project.nginxConfs.length) lines.push(`nginx: ${project.nginxConfs.join(", ")}`);
  if (!project.git) lines.push("Not a git repository (history checks are skipped)");
  return lines;
}
