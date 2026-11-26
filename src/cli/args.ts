export interface Args {
  command: string;
  project?: string;
  mode?: string;
  only?: string[];
  skip?: string[];
  out?: string;
  failOn: string;
  runner: "auto" | "docker" | "local";
  offline: boolean;
  updateBaseline: boolean;
  open: boolean;
}

const list = (value?: string) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined);

// Parses command line arguments.
export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const [key, inline] = item.slice(2).split("=", 2);
      if (inline !== undefined) values.set(key, inline);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) values.set(key, argv[++i]);
      else flags.add(key);
    } else if (!command) {
      command = item;
    } else if (!values.has("project")) {
      values.set("project", item);
    }
  }
  const runner = values.get("runner");
  return {
    command,
    project: values.get("project"),
    mode: values.get("mode"),
    only: list(values.get("only")),
    skip: list(values.get("skip")),
    out: values.get("out"),
    failOn: values.get("fail-on") ?? "none",
    runner: runner === "docker" || runner === "local" ? runner : "auto",
    offline: flags.has("offline"),
    updateBaseline: flags.has("update-baseline"),
    open: flags.has("open"),
  };
}

export const usage = `kensa: security and performance review for a project

Usage:
  kensa                           interactive mode
  kensa run --project <folder>    run without prompts
  kensa modules                   list modules
  kensa doctor                    check the environment

Options for run:
  --mode quick|standard       quick (no build) or standard (with Gradle analysis); default standard
  --only a,b                  run only these modules
  --skip a,b                  skip these modules
  --out <folder>              output folder
  --fail-on <rule>            none|new-high|new-medium|high; exit code 1 when matched
  --runner auto|docker|local  how external tools run (default auto)
  --offline                   do not download Semgrep registry rules
  --update-baseline           save this result as the baseline
  --open                      open the Excel report when finished
`;
