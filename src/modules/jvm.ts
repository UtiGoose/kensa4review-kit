import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGradle } from "../core/gradle";
import type { Category, CheckModule, Context, Finding, ProjectInfo, Severity } from "../core/types";
import { fingerprint, posix, relativeTo, snippet } from "../core/util";
import { runTrivy, trivyFindings } from "./trivy";

// Skips the module when the project has no Gradle wrapper.
const needsGradle = (project: ProjectInfo) =>
  !project.gradle ? "not a Gradle project" : !project.gradle.wrapper ? "no gradlew" : null;

// Lists raw files produced with the given prefix and extension.
function rawFiles(ctx: Context, prefix: string, extension: string): string[] {
  return readdirSync(ctx.rawDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(extension))
    .map((name) => join(ctx.rawDir, name));
}

// Resolves a source path reported by a tool to a project file.
function projectFile(ctx: Context, reported: string): string {
  const path = posix(reported).replace(/^file:\/*/, "");
  const relative = relativeTo(ctx.project.root, path);
  if (ctx.project.files.includes(relative)) return relative;
  const match = ctx.project.files.find((file) => file.endsWith(`/${path.replace(/^\//, "")}`));
  return match ?? relative;
}

export const gradleDepsModule: CheckModule = {
  id: "gradle-deps",
  title: "Gradle dependency vulnerabilities (SBOM + Trivy)",
  modes: ["standard"],
  localTool: { command: "trivy", args: ["--version"] },
  applies: needsGradle,
  async run(ctx) {
    const result = await runGradle(ctx, "deps.init.gradle", ["kensaDependencies"], { "kensa.out": ctx.rawDir }, "gradle-deps");
    const files = rawFiles(ctx, "deps-", ".txt");
    if (!files.length) throw new Error(`could not resolve dependencies (gradle exit code ${result.code}, see the logs)`);
    const components = new Map<string, { group: string; name: string; version: string }>();
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const coordinate = line.split("\t")[1];
        if (!coordinate) continue;
        const [group, name, version] = coordinate.split(":");
        components.set(coordinate, { group, name, version });
      }
    }
    ctx.log(`${components.size} dependencies`);
    const bom = {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: { component: { type: "application", name: ctx.project.name } },
      components: [...components.values()].map((item) => ({
        type: "library",
        "bom-ref": `pkg:maven/${item.group}/${item.name}@${item.version}`,
        group: item.group,
        name: item.name,
        version: item.version,
        purl: `pkg:maven/${item.group}/${item.name}@${item.version}`,
      })),
    };
    writeFileSync(join(ctx.rawDir, "gradle-bom.cdx.json"), JSON.stringify(bom, null, 2));
    const ok = await runTrivy(ctx, ["sbom", "/out/gradle-bom.cdx.json"], "trivy-gradle.json");
    if (!ok) throw new Error("Trivy produced no report (see the logs)");
    return trivyFindings(ctx, "gradle-deps", JSON.parse(readFileSync(join(ctx.rawDir, "trivy-gradle.json"), "utf8")), "Gradle dependencies");
  },
};

// Maps a SARIF level to the report severity.
function sarifSeverity(level: string): Severity {
  return level === "error" ? "high" : level === "warning" ? "medium" : "low";
}

export const spotbugsModule: CheckModule = {
  id: "spotbugs",
  title: "SpotBugs + FindSecBugs (bytecode analysis)",
  modes: ["standard"],
  applies: needsGradle,
  async run(ctx) {
    const versions = ctx.tool.gradle;
    const result = await runGradle(
      ctx,
      "spotbugs.init.gradle",
      ["spotbugsMain"],
      {
        "kensa.out": ctx.rawDir,
        "kensa.spotbugsPlugin": versions.spotbugsPlugin,
        "kensa.spotbugs": versions.spotbugs,
        "kensa.findsecbugs": versions.findsecbugs,
        "kensa.spotbugsExclude": join(ctx.tool.root, "rules", "spotbugs", "exclude.xml"),
      },
      "spotbugs",
    );
    const reports = rawFiles(ctx, "spotbugs-", ".sarif");
    if (!reports.length) throw new Error(`SpotBugs produced no report (gradle exit code ${result.code}, see the logs)`);
    const findings: Finding[] = [];
    for (const report of reports) {
      const sarif = JSON.parse(readFileSync(report, "utf8"));
      for (const run of sarif.runs ?? []) {
        const rules = new Map<string, { tags: string[]; security: boolean; name: string }>();
        const drivers = [run.tool?.driver, ...(run.tool?.extensions ?? [])].filter(Boolean);
        for (const driver of drivers) {
          const security = /sec/i.test(String(driver.name ?? ""));
          for (const rule of driver.rules ?? []) {
            rules.set(rule.id, { tags: rule.properties?.tags ?? [], security, name: rule.shortDescription?.text ?? rule.id });
          }
        }
        for (const item of run.results ?? []) {
          const rule = rules.get(item.ruleId);
          const tags = (rule?.tags ?? []).map((tag: string) => tag.toUpperCase());
          const category: Category = rule?.security || tags.includes("SECURITY") || tags.includes("MALICIOUS_CODE")
            ? "security"
            : tags.includes("PERFORMANCE")
              ? "performance"
              : "quality";
          const location = item.locations?.[0]?.physicalLocation;
          const file = location?.artifactLocation?.uri ? projectFile(ctx, location.artifactLocation.uri) : undefined;
          const line = location?.region?.startLine;
          findings.push({
            module: "spotbugs",
            rule: item.ruleId,
            title: rule?.name ?? item.ruleId,
            severity: sarifSeverity(item.level ?? "warning"),
            category,
            message: String(item.message?.text ?? "").trim(),
            file,
            line,
            fingerprint: fingerprint("spotbugs", item.ruleId, file, file && line ? snippet(ctx.project.root, file, line) : item.message?.text),
          });
        }
      }
    }
    return findings;
  },
};

// Decodes the XML entities used in PMD reports.
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// Parses a PMD XML report into findings.
export function parsePmd(xml: string, toFile: (path: string) => string, root: string): Finding[] {
  const findings: Finding[] = [];
  for (const fileMatch of xml.matchAll(/<file name="([^"]+)">([\s\S]*?)<\/file>/g)) {
    const file = toFile(decode(fileMatch[1]));
    for (const violation of fileMatch[2].matchAll(/<violation([^>]*)>([\s\S]*?)<\/violation>/g)) {
      const attrs = Object.fromEntries([...violation[1].matchAll(/(\w+)="([^"]*)"/g)].map((item) => [item[1], decode(item[2])]));
      const priority = Number(attrs.priority ?? 3);
      const ruleset = String(attrs.ruleset ?? "").toLowerCase();
      const category: Category = ruleset.includes("security") ? "security" : ruleset.includes("performance") ? "performance" : "quality";
      const severity: Severity = priority <= 1 ? "high" : priority <= 3 ? "medium" : priority === 4 ? "low" : "info";
      const line = Number(attrs.beginline ?? 0) || undefined;
      findings.push({
        module: "pmd",
        rule: attrs.rule,
        title: attrs.rule,
        severity,
        category,
        message: decode(violation[2]),
        file,
        line,
        refs: attrs.externalInfoUrl ? [attrs.externalInfoUrl] : [],
        fingerprint: fingerprint("pmd", attrs.rule, file, line ? snippet(root, file, line) : violation[2]),
      });
    }
  }
  return findings;
}

export const pmdModule: CheckModule = {
  id: "pmd",
  title: "PMD (error-prone and performance rules)",
  modes: ["standard"],
  applies: needsGradle,
  async run(ctx) {
    const result = await runGradle(
      ctx,
      "pmd.init.gradle",
      ["pmdMain"],
      {
        "kensa.out": ctx.rawDir,
        "kensa.pmd": ctx.tool.gradle.pmd,
        "kensa.pmdRuleset": join(ctx.tool.root, "rules", "pmd", "ruleset.xml"),
      },
      "pmd",
    );
    const reports = rawFiles(ctx, "pmd-", ".xml");
    if (!reports.length) throw new Error(`PMD produced no report (gradle exit code ${result.code}, see the logs)`);
    return reports.flatMap((report) => parsePmd(readFileSync(report, "utf8"), (path) => projectFile(ctx, path), ctx.project.root));
  },
};
