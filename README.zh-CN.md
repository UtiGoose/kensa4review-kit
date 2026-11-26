[English](README.md) | **简体中文**

# kensa

[![CI](https://github.com/UtiGoose/kensa4review-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/UtiGoose/kensa4review-kit/actions/workflows/ci.yml)

kensa（検査，日语"检查"）对 Spring Boot + React 项目做安全、性能和配置检查。它把常用的开源扫描工具和自带的检查组合在一起运行，所有结果汇总成一份 Excel 报告。被检查的项目不会被改动。

## 一次运行做什么

1. **选择项目。** 从最近用过的项目里选，或输入文件夹路径。
2. **识别技术栈。** Gradle/Maven、Java 和 Spring Boot 版本、Spring 配置、Flyway 迁移、Node 项目、Dockerfile、Compose 和 nginx 文件。只运行适用于该项目的检查；被 git 忽略的文件（`node_modules`、`build` 等）不在范围内，避免产生无关结果。
3. **读取项目配置。** 排除路径和已经审查并接受的问题，同样的判断不用做第二次。
4. **运行检查。** 外部工具通过 `tools.lock.json` 中固定版本的 Docker 镜像运行，所以每台机器上的工具版本和结果都一样。基于 Gradle 的检查通过临时 init script 加载，项目的构建文件不会被改动。无法运行的检查会注明原因后跳过，某个检查失败也不影响其他检查。
5. **统一结果格式。** 每条问题都有严重度、分类、位置和指纹。指纹由规则、文件和匹配到的代码计算，不依赖行号，所以代码上下移动后指纹不变。
6. **和基线比较。** 以前审查过的问题标为 Known，之后的运行只显示新增（New）的问题。
7. **把 Excel 报告**写到结果目录。

## 检查什么，为什么

| 模块 | 范围 | 需要 | 检查什么 | 为什么 |
|---|---|---|---|---|
| `endpoints` | quick、standard | – | 列出所有 Spring Controller 接口及其保护方式：角色/权限检查、仅需登录（`isAuthenticated()`）、无注解、公开（`permitAll`）。 | 访问控制失效是最常见的严重 Web 漏洞。没有角色检查的接口依赖 Service 层的检查，很容易漏掉。 |
| `spring-config` | quick、standard | – | `application*.yml/properties`：带默认值或直接写在文件里的密钥、Actuator 暴露范围、health 详情、生产环境开着 API 文档、`ddl-auto`、CORS `*`、错误详情、默认 DEBUG 日志、Open Session in View。 | 环境变量一旦没设置，默认密钥就会被悄悄使用。DEBUG 日志和 Open Session in View 会拖慢生产环境。 |
| `nginx` | quick、standard | – | 缺少安全头（CSP、X-Frame-Options、nosniff、Referrer-Policy、HSTS）、被 `location` 里的 `add_header` 覆盖掉的安全头、`server_tokens`、`autoindex`、旧版 TLS、过大的上传限制。 | nginx 只有在当前块没有任何 `add_header` 时才继承上层的设置，这是在最关键的页面上丢失安全头的常见原因。 |
| `flyway` | quick、standard | git | 提交后又被修改的迁移、被删除的迁移、重复版本号、迁移文件的未提交改动。 | 修改已执行的迁移会改变校验和，执行过它的数据库都会启动失败。 |
| `semgrep` | quick、standard | Docker | 按识别出的语言使用 Semgrep 官方规则（`p/java`、`p/javascript`、`p/typescript`、`p/react`、`p/owasp-top-ten`），外加自带规则：字符串拼接的 SQL（JDBC、JPA、jOOQ）、循环中调用 Repository（N+1）、无限制的 `findAll()`、`@Transactional` 里的外部调用、日志中输出敏感信息、对所有路径 `permitAll`、不校验签名的 JWT 解析、`dangerouslySetInnerHTML`、动态 `innerHTML`、把 token 存在 Web Storage、`eval`。 | 在源码中找出注入、XSS 和数据访问问题，包括只有在高负载下才会暴露的性能问题。 |
| `gitleaks` | quick、standard | Docker、git | 扫描**整个 git 历史**中的密钥（API key、token、密码、私钥），报告中会隐去实际值。 | 在后续提交里删掉密钥并不能把它从历史中移除，能拿到仓库的人仍然看得到。 |
| `trivy` | quick、standard | Docker | npm/bun/pnpm/yarn lockfile 中的已知漏洞。 | 大多数应用里第三方代码远多于自己写的代码。 |
| `hadolint` | quick、standard | Docker | Dockerfile 最佳实践（固定版本、非 root 用户、包管理器用法）。 | 镜像更小、可复现、更安全。 |
| `gradle-deps` | standard | JDK、Docker | 解析所有 Gradle 子项目的 runtime 和 compile classpath，生成 CycloneDX SBOM，再用 Trivy 扫描。 | Gradle 项目通常没有 lockfile，只看文件的扫描器看不到它的依赖。 |
| `spotbugs` | standard | JDK | 用 SpotBugs + FindSecBugs 插件分析编译后的 class：注入、弱加密、不安全的反序列化、资源泄漏、并发问题。 | 字节码分析能跟踪跨方法的数据流，找到模式匹配找不到的问题。 |
| `pmd` | standard | JDK | 精选的 PMD 规则：空 catch、未关闭的资源、丢失异常堆栈、循环中的字符串拼接、硬编码的加密密钥、双重检查锁等。 | 找出能编译通过但容易出错或低效的代码。 |

**Quick** 运行所有不需要构建的检查。**Standard** 再加上基于 Gradle 的模块，会用项目自己的 Gradle Wrapper 编译项目。

## 运行环境

- **Docker Desktop**（或 Docker Engine），并且处于运行状态。本机已安装的扫描工具会优先使用。
- **git**
- **能编译该项目的 JDK**，仅 standard 范围需要。
- **bun 1.4 及以上**，仅从源码运行时需要。
- 第一次运行时需要联网，下载镜像、Gradle 插件、Semgrep 规则和漏洞库，之后会被缓存。

## 安装

**从源码运行。**

```
git clone https://github.com/UtiGoose/kensa4review-kit.git kensa
cd kensa
bun install
```

之后本文中所有 `kensa` 命令都换成 `bun run start`。

**使用发布包。** 推送 `v0.1.0` 这样的标签后，会自动构建 `kensa-windows-x64.zip` 和 `kensa-linux-x64.zip`，并发布到 [GitHub Releases](https://github.com/UtiGoose/kensa4review-kit/releases)。解压到任意位置即可，`kensa.exe` 要和 `tools.lock.json`、`rules/`、`projects/` 放在同一个目录。

## 使用方法

检查环境：

```
kensa doctor
```

交互式运行：

```
kensa
```

1. **Project to check**：选择最近用过的项目、它旁边的文件夹，或选 "Enter a folder path…" 手动输入路径。
2. **Scope**：Standard（全部检查）、Quick（不构建）或 Custom（自选模块）。
3. **Open the report?**：打开 Excel 报告。
4. **Save this result as the baseline?**：看过结果后再选 yes。之后只有新增问题会被标成 New。

非交互运行：

```
kensa run --project D:\Code\my-app --mode standard --open
```

| 参数 | 说明 |
|---|---|
| `--mode quick\|standard` | 检查范围（默认 `standard`）。 |
| `--only a,b` / `--skip a,b` | 只运行／跳过指定模块（`kensa modules` 可查看模块）。 |
| `--out <文件夹>` | 输出目录（默认 `~/.kensa/runs/<项目名>/<时间戳>`）。 |
| `--fail-on <条件>` | `none`、`new-high`、`new-medium`、`high`。满足条件时退出码为 1。 |
| `--runner auto\|docker\|local` | 本机有工具就用本机（`auto`）、始终用 Docker、或只用本机。 |
| `--offline` | 不下载 Semgrep 官方规则，只运行自带规则。 |
| `--update-baseline` | 把本次结果保存为基线。 |
| `--open` | 结束后打开 Excel 报告。 |

## 报告

每次运行会在结果目录里输出 `review-<项目名>-<年月日-时分>.xlsx`：

| 工作表 | 内容 |
|---|---|
| `Summary` | 项目、开始时间、耗时、检查范围、项目配置、识别出的技术栈；按严重度和状态统计的件数；每个模块的执行状态。 |
| `By rule` | 每条规则一行（依赖漏洞按包汇总为一行）：最高严重度和件数，严重的排在前面。建议从这里开始看。 |
| 每个模块一张表 | 每条问题一行：严重度、状态、标题、详情、文件、行号、修复建议、规则、分类、备注、参考链接、指纹。 |
| `API inventory` | 所有 Controller 接口的 HTTP 方法、路径和保护方式，保护最弱的排在前面。 |

状态：**New**（不在基线中）、**Known**（已在基线中）、**Accepted**（已在项目配置中接受；接受期限过后会重新出现）。

结果目录里还会保留 `raw/`（各工具的原始输出）和 `logs/`。

## 项目配置（profile）

项目配置记录对某个项目已经做出的判断。按顺序查找项目中的 `.review/profile.yml`，然后是 kensa 中的 `projects/<文件夹名（小写）>/profile.yml`。基线文件保存在配置文件旁边。`projects/` 不纳入 git，里面的配置只保存在本机；要和团队共享，请放在该项目自己的 `.review/profile.yml` 中。

```yaml
exclude:                        # 不扫描的路径（glob）
  - design
modules:
  skip: [pmd]                   # 这个项目永远不运行的模块
semgrep:
  registry: [p/java]            # 官方规则包；不写则自动选择
flyway:
  policy: warn                  # off 表示关闭 Flyway 检查
accepted:
  - module: spring-config       # 可用 module、rule、path、text、fingerprint 任意组合匹配
    rule: secret-default
    text: app.example.api-key   # 问题标题或内容中包含的文字
    reason: 2026-11-20 经组长确认
    expires: 2027-06-30
```

如果存在 `projects/<项目名>/gitleaks.toml`，gitleaks 会使用它，例如放行已知的测试用 key。
