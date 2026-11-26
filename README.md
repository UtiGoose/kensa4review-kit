**English** | [简体中文](README.zh-CN.md)

# kensa

[![CI](https://github.com/UtiGoose/kensa4review-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/UtiGoose/kensa4review-kit/actions/workflows/ci.yml)

kensa (検査, "inspection") checks a Spring Boot + React project for security, performance and configuration problems. It runs well-known open-source scanners together with its own checks and writes all results into one Excel report. The project being checked is not changed.

## What a run does

1. **Choose a project.** Pick a recent project or enter a folder path.
2. **Detect the stack.** Gradle/Maven, Java and Spring Boot versions, Spring configuration, Flyway migrations, Node projects, Dockerfiles, Compose and nginx files. Only checks that apply to the project are run, and files ignored by git (`node_modules`, `build`, …) are left out so they do not produce noise.
3. **Load the project profile.** Exclusions and findings that were already reviewed and accepted, so the same decision is not made twice.
4. **Run the checks.** External tools run from Docker images pinned in `tools.lock.json`, so every machine gets the same tool versions and the same result. Gradle-based checks are loaded through temporary init scripts, so the project's build files stay untouched. A check that cannot run is skipped with the reason, and a failing check does not stop the others.
5. **Normalize the results.** Every finding gets a severity, a category, a location and a fingerprint. The fingerprint is based on the rule, the file and the matched code instead of the line number, so it stays the same when code moves.
6. **Compare with the baseline.** Findings that were reviewed before are marked Known, so later runs show only what is New.
7. **Write the Excel report** into the run folder.

## What is checked, and why

| Module | Scope | Needs | What it checks | Why |
|---|---|---|---|---|
| `endpoints` | quick, standard | – | Lists every Spring controller endpoint and how it is protected: role/permission check, sign-in only (`isAuthenticated()`), no annotation, or public (`permitAll`). | Broken access control is the most common serious web vulnerability. Endpoints without a role check depend on checks in the service layer, which are easy to forget. |
| `spring-config` | quick, standard | – | `application*.yml/properties`: secrets with default values or written in the file, Actuator exposure, health details, API docs left on in prod, `ddl-auto`, CORS `*`, error details, DEBUG logging by default, Open Session in View. | A default secret is used silently whenever an environment variable is missing. Debug logging and Open Session in View cost performance in production. |
| `nginx` | quick, standard | – | Missing security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy, HSTS), headers dropped by `add_header` inside a `location`, `server_tokens`, `autoindex`, old TLS versions, large upload limits. | nginx only inherits `add_header` when a block defines none of its own, a common way to lose security headers on the very page that matters. |
| `flyway` | quick, standard | git | Migrations edited after they were added, deleted migrations, duplicate versions, uncommitted changes to migrations. | Editing an applied migration changes its checksum, and every database that applied it fails to start. |
| `semgrep` | quick, standard | Docker | Semgrep registry rules for the detected languages (`p/java`, `p/javascript`, `p/typescript`, `p/react`, `p/owasp-top-ten`) plus bundled rules: SQL built by concatenation (JDBC, JPA, jOOQ), repository calls in loops (N+1), unbounded `findAll()`, external calls inside `@Transactional`, secrets in logs, `permitAll` on all paths, unsigned JWT parsing, `dangerouslySetInnerHTML`, dynamic `innerHTML`, tokens in web storage, `eval`. | Finds injection, XSS and data-access patterns in the source code, including performance problems that only show up under load. |
| `gitleaks` | quick, standard | Docker, git | Secrets (API keys, tokens, passwords, private keys) in the **entire git history**. Values are redacted in the report. | Deleting a secret in a later commit does not remove it from history; anyone with the repository can still read it. |
| `trivy` | quick, standard | Docker | Known vulnerabilities in npm/bun/pnpm/yarn lockfiles. | Most applications ship far more third-party code than their own. |
| `hadolint` | quick, standard | Docker | Dockerfile best practices (pinned versions, non-root user, package manager usage). | Smaller, reproducible and safer images. |
| `gradle-deps` | standard | JDK, Docker | Resolves the runtime and compile classpath of every Gradle project, writes a CycloneDX SBOM and scans it with Trivy. | Gradle projects usually have no lockfile, so file-based scanners cannot see their dependencies. |
| `spotbugs` | standard | JDK | SpotBugs with the FindSecBugs plugin on compiled classes: injection, weak cryptography, unsafe deserialization, resource leaks, concurrency bugs. | Bytecode analysis follows data through method calls and finds bugs that pattern matching misses. |
| `pmd` | standard | JDK | A focused PMD rule set: empty catch blocks, unclosed resources, lost stack traces, string concatenation in loops, hard-coded crypto keys, double-checked locking and similar. | Catches error-prone and inefficient code that compiles cleanly. |

**Quick** runs everything that needs no build. **Standard** adds the Gradle-based modules, which compile the project with its own Gradle wrapper.

## Requirements

- **Docker Desktop** (or Docker Engine), running. If a scanner is installed locally, it is used instead.
- **git**
- **A JDK that can build the project**, only for the standard scope.
- **bun 1.4 or later**, only when running from source.
- Network access on the first run, to download the images, Gradle plugins, Semgrep rules and the vulnerability database. They are cached afterwards.

## Installation

**From source.**

```
git clone https://github.com/UtiGoose/kensa4review-kit.git kensa
cd kensa
bun install
```

Then use `bun run start` wherever this guide says `kensa`.

**From a release.** Pushing a tag such as `v0.1.0` builds `kensa-windows-x64.zip` and `kensa-linux-x64.zip` and attaches them to a [GitHub release](https://github.com/UtiGoose/kensa4review-kit/releases). Unzip one anywhere and keep `kensa.exe` next to `tools.lock.json`, `rules/` and `projects/`.

## Usage

Check the environment:

```
kensa doctor
```

Run interactively:

```
kensa
```

1. **Project to check**: choose a recent project, a folder next to one, or "Enter a folder path…".
2. **Scope**: Standard (all checks), Quick (no build) or Custom (choose modules).
3. **Open the report?**: opens the Excel report.
4. **Save this result as the baseline?**: answer yes after you have reviewed the findings. From then on, only new findings are marked New.

Run without prompts:

```
kensa run --project D:\Code\my-app --mode standard --open
```

| Option | Meaning |
|---|---|
| `--mode quick\|standard` | Scope (default `standard`). |
| `--only a,b` / `--skip a,b` | Run only, or skip, the listed modules (`kensa modules` lists them). |
| `--out <folder>` | Output folder (default `~/.kensa/runs/<project>/<timestamp>`). |
| `--fail-on <rule>` | `none`, `new-high`, `new-medium` or `high`. Exit code 1 when matched. |
| `--runner auto\|docker\|local` | Use local tools when installed (`auto`), always Docker, or local only. |
| `--offline` | Do not download Semgrep registry rules; run the bundled rules only. |
| `--update-baseline` | Save this result as the baseline. |
| `--open` | Open the Excel report when finished. |

## Report

Each run writes `review-<project>-<yyyymmdd-hhmm>.xlsx` into the run folder:

| Sheet | Content |
|---|---|
| `Summary` | Project, start time, duration, scope, profile and detected stack; findings by severity and status; the status of every module. |
| `By rule` | One row per rule (per package for dependency vulnerabilities) with its highest severity and the number of findings, most severe first. Start reading here. |
| One sheet per module | One row per finding: severity, status, title, details, file, line, fix, rule, category, note, references, fingerprint. |
| `API inventory` | Every controller endpoint with its HTTP method, path and protection, weakest first. |

Statuses: **New** (not in the baseline), **Known** (in the baseline), **Accepted** (accepted in the project profile; shown again when the acceptance expires).

The run folder also keeps `raw/` (the original tool output) and `logs/`.

## Project profile

A profile holds what was decided for one project. It is looked up in `.review/profile.yml` inside the project, then in `projects/<folder name in lower case>/profile.yml` inside kensa. The baseline is stored next to it. `projects/` is ignored by git, so profiles there stay on your machine; to share a profile with the team, put it in the project's own `.review/profile.yml`.

```yaml
exclude:                        # paths not scanned (globs)
  - design
modules:
  skip: [pmd]                   # modules never run for this project
semgrep:
  registry: [p/java]            # registry packs; omit for automatic selection
flyway:
  policy: warn                  # off disables the Flyway checks
accepted:
  - module: spring-config       # match by any of module, rule, path, text, fingerprint
    rule: secret-default
    text: app.example.api-key   # text contained in the finding
    reason: Approved by the team lead on 2026-11-20
    expires: 2027-06-30
```

If `projects/<name>/gitleaks.toml` exists, gitleaks uses it, for example to allow a known test key.
