export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "security" | "performance" | "quality" | "config" | "dependency" | "secret";
export type Mode = "quick" | "standard";
export type Status = "new" | "baseline" | "accepted";

export interface Finding {
  module: string;
  rule: string;
  title: string;
  severity: Severity;
  category: Category;
  message: string;
  file?: string;
  line?: number;
  hint?: string;
  refs?: string[];
  fingerprint: string;
  status?: Status;
  note?: string;
}

export interface NodeProject {
  dir: string;
  manager: "bun" | "npm" | "pnpm" | "yarn" | "unknown";
  lockfiles: string[];
  frameworks: string[];
}

export interface ProjectInfo {
  root: string;
  name: string;
  files: string[];
  git: boolean;
  gradle?: { wrapper: string | null; javaDirs: string[] };
  maven?: { javaDirs: string[] };
  javaVersion?: string;
  springBoot?: string;
  springConfigs: string[];
  javaSources: string[];
  node: NodeProject[];
  dockerfiles: string[];
  composeFiles: string[];
  nginxConfs: string[];
  migrations: string[];
}

export interface Accepted {
  module?: string;
  rule?: string;
  path?: string;
  text?: string;
  fingerprint?: string;
  reason: string;
  expires?: string;
}

export interface Profile {
  source: string | null;
  dir: string;
  exclude: string[];
  skip: string[];
  semgrepRegistry?: string[];
  flywayPolicy: "warn" | "off";
  accepted: Accepted[];
}

export interface ToolPaths {
  root: string;
  home: string;
  images: Record<string, string>;
  gradle: Record<string, string>;
}

export interface Context {
  project: ProjectInfo;
  profile: Profile;
  tool: ToolPaths;
  runDir: string;
  rawDir: string;
  logDir: string;
  runner: "auto" | "docker" | "local";
  offline: boolean;
  log: (message: string) => void;
}

export interface CheckModule {
  id: string;
  title: string;
  modes: Mode[];
  localTool?: { command: string; args: string[] };
  applies: (project: ProjectInfo) => string | null;
  run: (ctx: Context) => Promise<Finding[]>;
}

export interface ModuleResult {
  module: string;
  title: string;
  status: "ok" | "failed" | "skipped";
  reason?: string;
  seconds: number;
  count: number;
}

export interface RunResult {
  project: ProjectInfo;
  profile: Profile;
  mode: string;
  startedAt: string;
  finishedAt: string;
  runDir: string;
  modules: ModuleResult[];
  findings: Finding[];
}

export const severityOrder: Severity[] = ["critical", "high", "medium", "low", "info"];

export const severityLabel: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export const categoryLabel: Record<Category, string> = {
  security: "Security",
  performance: "Performance",
  quality: "Quality",
  config: "Configuration",
  dependency: "Dependency",
  secret: "Secret",
};

export const statusLabel: Record<Status, string> = {
  new: "New",
  baseline: "Known",
  accepted: "Accepted",
};

// Returns true when a is at least as severe as b.
export function atLeast(a: Severity, b: Severity): boolean {
  return severityOrder.indexOf(a) <= severityOrder.indexOf(b);
}
