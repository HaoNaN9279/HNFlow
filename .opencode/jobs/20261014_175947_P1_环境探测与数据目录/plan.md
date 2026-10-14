# N11 计划：环境探测与数据目录规范（P1 切片 7）

> 依据：《HNFlow 开发方案》§22 前两条（环境探测：软件版本、插件、语言运行时、路径探测，与能力包绑定并在加载时校验；数据目录规范：单机数据目录布局 definitions / checkpoints / assets / app sessions）、§5.4 能力包依赖解析、§12.4 幂等与确认、《HNFlow 开发规划》§四 N11 行 / §五 P1 第 7 项。
> 状态：**已完成（S1–S7）**，提交 \e8128e\（Q1/Q2/Q3 均按建议裁决）。
> 前置：切片 1–6 已提交（HEAD = `a0943fd`，N10b 功能 `77c84ed`）。
> 非目标提醒：§22 第三条「备份与迁移（导出导入 + 数据目录复制）」独立为 **N11b**（见 Q1）。

## 1. 范围

**做**：
- **(A) 环境探测**：声明「这台机器上要有什么」（可执行文件 / 版本 / 路径 / 语言运行时 / 应用插件），探测它们，把结果作为**三态**报告（满足 / 缺失 / 不匹配，外加「探不出」），并与**能力包**绑定、在**加载时**校验。
- **(B) 数据目录规范**：把单机数据目录布局（definitions / checkpoints / assets / app sessions / users / threads / locks / undo / 派生索引）集中成**一份可读的规范 + 访问器 + 校验**，启动时确保必需项存在，并提供只读报告（API + CLI）。

**不做**（明确留后续）：
- **备份/导出导入/迁移**（§22 第三条）→ N11b。
- **自动修复环境**：探测**只读** —— 不安装、不下载、不改环境变量、不写宿主（`path` 只判存在性，不创建）。
- 真实性能/GPU 计量（N8 已声明是 explicit follow-up）、驱动矩阵其余驱动（Unity 等）。
- 前端 UI（报告是运维面 API + CLI；延续 deferred）。

## 2. 复用锚点（不造新栈）

| 已有能力 | 位置 | N11 用法 |
| --- | --- | --- |
| 可执行可达性判定 | `apps/drivers/cli.py::CliAppDriver.available`（`shutil.which` / 绝对路径 `exists`） | `executable`/`runtime` 探测沿用同一判定，不写第二套 |
| **悬空字段** | `config/apps_config.py:148` `AppDefinition.version_command`（已声明、**代码里从未被读取**） | N11 把它真正接上：应用自身版本探测 |
| 同位置 argv 规则 | `AppDefinition.presence_command`（N10b）、`run_script` 的 script 位置 | `version_command` 复用同一位置规则，**不自造引号/路径分隔符规则** |
| 声明 + 实现双条件 | `driver_supports_undo`（N10）/ `driver_supports_presence`（N10b） | 需要驱动配合的探测沿用；纯环境探测不需要驱动 |
| 纯函数决策先例 | `scheduler/triggers.py::is_trigger_due`（N7）、`apps/presence.py::decide_access`（N10b）、`workflow/preview.py::make_preview`（N10） | `evaluate_probe` / `summarize_requirements` 同构：判定是纯函数，I/O 在外面 |
| fail-open 诊断先例 | 扩展系统（optional plugin 加载失败 fail open with diagnostics）、`driver.available` fail-open 条目 | 探测失败**默认不阻塞**启动，只诊断；可显式升级为硬门 |
| frontmatter 解析 fail-soft 先例 | `skills/parser.py::parse_required_secrets`（非法项 warn 后丢弃） | SKILL.md `requires:` 同构 |
| 结构化配置模型 | `AppResourceDemand` / `LicenseGroup`（`extra="forbid"`） | `RequirementSpec` 同风格 |
| 路径单点 | `config/paths.py::Paths` + `get_paths()` | `data_dirs()` 挂在 `Paths` 上，不新建路径系统 |
| 短 TTL 探测缓存 | `apps/session.py::probe_presence`（5s 缓存 + `force`） | 同构：探测结果进程内短缓存，`?force=true` 现场重探 |
| CLI 入口先例 | `workflow/check_cycles.py` + `workflow/__main__.py` | `python -m deerflow.environment`，退出码可进 CI |
| 只读端点先例 | `routers/features.py` | `GET /api/environment` |

## 3. 设计决策

- **D1 范围 = §22 前两条**：环境探测（A）+ 数据目录规范（B）；备份/迁移（第三条）独立 N11b（Q1 待裁决）。
- **D2 探测只读**：只回答「查得到吗 / 什么版本 / 路径在不在」。不安装、不下载、不改环境、不写宿主；唯一创建目录的动作是显式调用 `ensure_data_dirs()`，且只创建 `{base_dir}` **自己名下**的目录。
- **D3 结果是三态 + unknown**：`ok`（满足）/ `missing`（应有而无）/ `mismatch`（存在但版本不符）/ `unknown`（探不出：超时、非 0 退出、输出不可解析）。**`unknown` 既不算通过也不算失败** —— 探测是尽力而为，把「探不出」当成「不满足」会让没有版本命令的软件一律不可用（N10b 对 presence 的同一取舍）。`/ `optional: true` 的项不参与 overall 判定。
- **D4 版本比较是纯函数**：`parse_version` / `version_satisfies(observed, constraint)`，支持 `>=` `>` `<=` `<` `==` `!=` `^` `~` `*` 与逗号组合（`">=4.0,<5"`）；容忍 `v` 前缀、非数字后缀（`4.2.1 LTS`）、段数不等（`4.2` vs `4.2.0`）。**版本串不可解析 → `unknown`，绝不猜成 `ok`**。不引入 `packaging` 依赖（D14）。
- **D5 需求是声明式数据，不是代码**：`RequirementSpec{kind, name, command, expect, optional}`，五类 `kind`：
  - `executable`：`name` 经 `PATH`（`shutil.which`）或绝对路径可达；
  - `version`：跑 `command`（**argv 列表**，缺省 `[name, "--version"]`）取首个版本样 token，与 `expect` 比较；
  - `path`：`name` 展开 `$VAR`/`~` 后**必须存在**（相对路径相对**进程工作目录**）；
  - `runtime`：语言运行时（`python` / `node` / `uv` …）= `executable` + `version` 的组合语义（报告里单列一类）；
  - `plugin`：应用插件/扩展的存在性，相对路径相对**该应用的 `working_dir`**（这是它与 `path` 唯一但真实的语义差别），`name` 也可是 `$VAR` 或绝对路径。
  `command` 用 **argv 列表**而非字符串：避免自造 shell 引号/`PATHEXT`/反斜杠规则（N10b 对 `presence_command` 的同一理由）。
- **D6 加载时校验，但默认 fail-open**：`apps.environment.require_on_load: false`（默认）→ 只诊断（启动日志一条汇总 + API 报告）；`true` → 必需项 `missing`/`mismatch` 让 Gateway 启动失败。理由：机器上装了但今天没用的软件少一个插件，不该让整个 Gateway 起不来；而锁定环境的部署需要硬门，两者都要能表达。
- **D7 与能力包绑定**：SKILL.md frontmatter 新增 `requires:`（同一 `RequirementSpec` 模型），解析进 `Skill.requirements`。只有 **enabled** 技能参与校验（未启用的技能，其需求与你无关）。报告按来源分组（apps / skills），并保留分组名。
- **D8 探测结果不是持久事实**：不写库、不写文件；进程内短 TTL 缓存（默认 5s，镜像 N10b presence 缓存），`?force=true` 现场重探。软件今天装明天卸，落库只会制造陈旧真相。
- **D9 数据目录规范 = 列表 + 访问器 + 校验，不改任何现有路径**：`Paths.data_dirs()` 返回 `DataDir{name, path, purpose, scope, required}` 的有序列表；`check_data_dirs()` 报 `exists`/`writable`（**不创建**）；`ensure_data_dirs()` 创建 `required` 项（幂等）。既有目录常量与属性一个都不动 —— 本切片只是把散落的 `Paths` 属性「列表化」并加上可写性检查。
- **D10 覆盖范围**：base、memory（`memory.json`/`USER.md`）、`users/`、`threads/`、`skills_view/`（投影）、`integrations/`、`locks/`（N8 跨进程锁）、`undo/`（N10 补偿备份）、memory 派生索引（`.retrieval`）、SQL 数据库文件所在目录（checkpointer + 应用表）。逐项标注 purpose/scope（global | per-user）与 `required`（按当前配置推导：如 `memory.enabled=false` 时 memory 相关标非必需）。
- **D11 API 只读、additive**：`GET /api/environment[?force=true]` → `{data_dirs: [...], requirements: {apps: [...], skills: [...]}, overall: "ok"|"degraded"|"missing"}`。**不加写端点** —— 探测无副作用，没有需要写的东西；要硬门用配置。`GET /api/features` 增 `environment.enabled`。
- **D12 前端零改动**（运维面 API + CLI；前端尾巴延续 deferred）。
- **D13 CLI 可进 CI**：`python -m deerflow.environment [--json] [--force] [--no-color]`，退出码 `0` = 无必需项失败（`ok`/`degraded`/纯 `unknown` 都算 0）、`1` = 有 `missing`/`mismatch` 必需项、`2` = 自身错误。与 `deerflow.workflow.check_cycles` 同风格。
- **D14 不加依赖**：版本比较自己写；子进程探测用 `subprocess.run(argv, timeout=..., check=False, capture_output=True, text=True)`，**不经 shell**。
- **D15 `config_version` 39→40；无迁移、无新表；`environment` 挂在 `apps` 段下**（`apps.environment`）故沿用 `apps` 的 startup-only 注册，不新增 `STARTUP_ONLY_FIELDS` 项。

## 4. 步骤

### S1 探测纯原语（无 I/O）
- 新 `deerflow/environment/`（harness 包，与 `apps/`/`assets/`/`resources/`/`locks/` 同级）：
  - `spec.py`：`ProbeKind`（`executable`/`version`/`path`/`runtime`/`plugin`）、`RequirementSpec`（pydantic，`extra="forbid"`，`kind` 校验、`command` argv 校验、`expect` 归一）、`ProbeOutcome` 常量、`ProbeResult{spec, outcome, observed, detail}`、`RequirementReport{source, label, items, overall}`。
  - `version.py`：`parse_version`、`version_satisfies`（约束解析 + 比较，不可解析 → `None`/`unknown`）。
  - `evaluate.py`：`evaluate_probe(spec, observed) -> outcome`（决定表）、`summarize_requirements(reports) -> "ok"|"degraded"|"missing"`。
- 验收：`tests/test_environment_spec.py`（`RequirementSpec` 合法/非法、版本比较逐行表含 `^`/`~`/通配/不可解析、`optional` 不参与 overall、决定表逐行）。

### S2 探测执行器（I/O）
- `environment/probe.py`：`run_probe(spec, *, working_dir=None, timeout=...) -> ProbeResult`（`shutil.which` / `expandvars`+`exists` / `subprocess.run`；**永不抛**：`OSError`/超时/非 0 退出/空输出 → `unknown` + detail）、`probe_all(specs, ...) -> list[ProbeResult]`、进程内短 TTL 缓存（`probe_cached`，可 `force`）、`clear_probe_cache()`。
- 验收：`tests/test_environment_probe.py`（命中/未命中、绝对路径与 `$VAR`、超时、非 0 退出、乱码输出、版本提取含 `v` 前缀与 `LTS` 后缀、缓存命中与 `force` 绕缓存）。测试目标用 `command=[sys.executable, "-c", "print('4.2.1')"]` 等 → **不依赖真实已装软件**、跨平台。

### S3 配置：`apps.environment` + `AppDefinition.requires` + 接上 `version_command`
- `config/apps_config.py`：`EnvironmentConfig{enabled: bool = True, require_on_load: bool = False, probe_timeout_seconds: float = 5.0, cache_seconds: float = 5.0}`、`AppsConfig.environment: EnvironmentConfig`、`AppDefinition.requires: list[RequirementSpec] = []`；`version_command` 文档明确为「应用自身版本 token，按 `presence_command`/`run_script` 的同一位置追加」。
- `config.example.yaml`：`apps.environment` 段 + `requires` 示例注释；`config_version: 39` → `40`。
- 验收：`tests/test_apps_config_requires.py`（默认值 = 今天行为、非法 kind/command 拒绝、空 `requires` 零影响、`environment` 默认值）。

### S4 与能力包绑定 + 加载校验
- `skills/parser.py::parse_requirements(raw, skill_file)`（复用 `RequirementSpec`；非法项 warn 丢弃，与 `parse_required_secrets` 同构）、`skills/types.py::Skill.requirements`。
- `environment/requirements.py`：`collect_app_requirements(registry)`、`collect_skill_requirements(skills)`（仅 enabled）、`validate_environment(*, registry, skills, force) -> EnvironmentReport`（纯结构 + 一次批量探测）、`required_failures(report)`（`require_on_load` 判定用）。
- 验收：`tests/test_skill_requires_frontmatter.py`（解析、非法丢弃、缺省空）、`tests/test_environment_requirements.py`（apps/skills 分组、禁用技能不校验、`required_failures` 只挑必需项失败、`unknown` 不算失败）。

### S5 数据目录规范
- `config/paths.py`：`DataDir`、`Paths.data_dirs() -> list[DataDir]`、`check_data_dirs() -> list[DataDirStatus{name,path,exists,writable,required}]`、`ensure_data_dirs() -> list[Path]`（幂等，只创建必需项）。
- 覆盖 D10 列出的目录；`purpose` 一句人话；`scope` = `global`/`per-user`；`required` 按当前配置推导（如 memory 关闭时 memory 项非必需）。
- 验收：`tests/test_data_dirs.py`（列表完整且都在 `base_dir` 内、`per-user` 项模板不带具体 user、`writable` 判定（只读目录 → False）、`ensure` 幂等且不创建非必需项、`check` 不产生副作用）。

### S6 报告：启动校验 + API + CLI
- `app/gateway/app.py`（lifespan）：调用 `ensure_data_dirs()` + 一次性探测校验；`require_on_load=true` 且有必需项失败 → 启动失败（错误信息列出失败项与修复提示），否则记一条汇总日志。
- 新 `app/gateway/routers/environment.py`：`GET /api/environment`（`?force=true`；探测与目录检查经 `asyncio.to_thread` 离开事件循环）；`routers/features.py` 增 `environment.enabled`；`app.py` 注册路由。
- `deerflow/environment/__main__.py`：`python -m deerflow.environment [--json] [--force]`（人类可读 + `--json` 机器可读，退出码见 D13）。
- 验收：`tests/test_environment_routes.py`（默认报告结构、`force` 生效、探测失败 → `unknown` 不 5xx、`features` 新增字段）、`tests/test_environment_cli.py`（退出码 0/1、`--json` 结构、无副作用）。

### S7 文档 + 全量回归 + 提交
- 文档：根 `AGENTS.md`（工作流子系统旁新增「环境探测与数据目录」小节）、`backend/AGENTS.md`（新节 + Routers 表 `Environment` 行 + `config_version` 40 + 数据目录布局）、`HNFlow 开发规划.md`（N11 行、P1 第 7 项、M4 行、切片 7 进度注）、`config.example.yaml`。
- 验证：`ruff check` + `format --check` 全绿；全量离线回归（**N10b 基线 75 failed / 10436 passed / 104 skipped**，本切片预期同样 75 既有平台失败 + 新增测试全绿）；前端 `pnpm test`/`check`（零改动守门）。
- 提交：`feat(environment): N11 环境探测与数据目录规范（requires 探测 + 加载校验 + 数据目录报告）` + 跟踪归档小提交。

## 5. 验证策略

- TDD：每步先写测试。命令：`cd backend` + `$env:PYTHONPATH="."` + `.venv\Scripts\python.exe -m pytest <files> -q -p no:cacheprovider`。
- async 测试显式 `@pytest.mark.asyncio`（strict）；同步测试内跑异步用 `asyncio.run`。
- **不依赖真实已装软件**：探测目标一律用 `[sys.executable, "-c", "print('4.2.1')"]` 这类 argv，或 tmp 目录里的假插件路径；`executable` 命中用 `sys.executable` 的 basename，未命中用 `definitely-not-installed-xyz`。
- 默认行为回归：**未声明 `requires` / 未开 `environment.*` 的配置必须逐字节保持现状**（专项断言 + 全量回归佐证）。
- 版本比较用表驱动测试锁死 `^`/`~`/`*`/逗号组合/不可解析的语义。

## 6. 开放问题（请裁决）

- **Q1 范围**：本切片 = §22 **前两条**（环境探测 + 数据目录规范），把第三条（备份/导出导入/换机迁移）独立为 **N11b**？（建议：是 —— 三条彼此独立；合并后单切片规模明显超过此前每个切片，审查与验证都会变形。）
- **Q2 探测失败语义**：默认 **warn-only（fail-open）+ 三态报告**（`unknown` 既不算通过也不算失败），并给 `apps.environment.require_on_load: true` 作为启动硬门？（建议：是 —— 缺一个今天用不到的插件不该让 Gateway 起不来，但锁定环境需要硬门。）
- **Q3 需求声明方式**：app 用 `AppDefinition.requires`（`command` 为 **argv 列表**，避免自造引号规则）、能力包用 SKILL.md frontmatter `requires:`（同一模型），并把现存悬空字段 `AppDefinition.version_command` 接成「应用自身版本」探测（与 `presence_command` 同位置规则）；校验只覆盖 **enabled** 技能？（建议：是。）
