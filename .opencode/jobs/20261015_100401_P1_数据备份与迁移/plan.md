# N11b 计划：数据备份 / 导出导入 / 换机迁移（P1 切片 8）

> 依据：《HNFlow 开发方案》§22 第三条「备份与迁移：导出导入 + 数据目录复制，支持换机迁移与恢复」、§24.16「单机版本 / 备份迁移（轻量保留）」；《HNFlow 开发规划》§四 N11 行（◐ → 本切片收口）、§五 P1 第 7 项、M4 行。
> 状态：**已完成（S1–S6）**，提交 `5b91c83`（Q1–Q4 均按建议裁决）。
> 前置：切片 1–7 已提交（HEAD = `ebf7fbd`，N11 功能 `ae8128e`）。
> 关系：N11 已交付「环境探测 + 数据目录规范」，`Paths.data_dirs()` 是**规范本身**，并已写明「完整备份 = 一组路径 + 那个数据库文件」。N11b 是它的直接延续，不重造规范。

## 1. 范围

**做**（§22 第三条）：
- **(A) 导出**：把单机数据（N11 规范的数据目录 + SQL 库）打成一个**单文件归档**（含 `manifest.json`），供运维归档与换机迁移。
- **(B) 导入 / 恢复**：从归档恢复到本机（空目标默认；覆盖需显式 `--force`），校验归档格式与版本、拒绝不安全条目。
- **(C) 只读预览**：`GET /api/backup` 返回「一次备份会包含什么」（目录/库/排除项），不产生副作用。

**不做**（明确留后续 / 永久不做）：
- 云端同步 / 增量备份 / 加密 / 签名（§24.13 供应链已裁撤）。
- 在 Gateway 运行中通过 HTTP 导入（会覆盖正在使用的库）——导入是**离线 CLI 操作**。
- Postgres 库内容的打包（由运维用 `pg_dump` 承担；归档只记录后端与说明）。
- 前端 UI（运维面 API + CLI；延续 N11 deferred）。
- 环境探测 / 数据目录规范的任何改动（N11 已交付）。

## 2. 复用锚点（不造新栈）

| 已有能力 | 位置 | N11b 用法 |
| --- | --- | --- |
| 数据目录规范（有序、带 purpose/scope/required） | `config/paths.py::Paths.data_dirs()`（N11） | 归档清单的**唯一来源**，不另列目录 |
| 只读目录体检 | `config/paths.py::check_data_dirs()` | `GET /api/backup` 预览复用，不新写扫描 |
| 统一库配置 | `config/database_config.py::DatabaseConfig`（`backend`/`sqlite_path`） | 决定「库是否入包」与源文件路径 |
| 资产白名单 | `config/assets_config.py::AssetsConfig.roots`（N9） | `--include-assets` 的源（默认关，操作员自有的宿主目录） |
| 纯函数决策先例 | `scheduler/triggers.py::is_trigger_due`（N7）、`apps/presence.py::decide_access`（N10b）、`environment/evaluate.py`（N11） | `plan_backup` / `plan_restore` / `check_import_compatible` 同构：判定纯函数，I/O 在外 |
| CLI + 退出码先例 | `workflow/check_cycles.py`、`environment/__main__.py`（N11） | `python -m deerflow.portability`，退出码可进 CI |
| 只读端点先例 | `routers/environment.py`（N11） | `GET /api/backup` |
| 归档写穿透 best-effort 先例 | `apps/persistence.py`（N6）、`workflow/compensation.py`（N10） | 导出失败要显式报错（导出是操作员动作，不能静默）|

## 3. 设计决策

- **D1 范围 = §22 第三条**：只做导出 / 导入 / 只读预览。环境探测与数据目录规范不动。
- **D2 归档 = 单文件 zip + `manifest.json`**：一个文件便于换机搬运。逻辑布局与机器无关：`dirs/<name>/…`（`name` 取自 `DataDir.name`）、`database/<file>`、`assets/<idx>/…`；`manifest.json` 在归档根。**不写绝对路径进逻辑布局**，因此目标机 `base_dir` 不同也能恢复。
- **D3 导出 SQL 库（sqlite）= 一致性快照**：用 `sqlite3.Connection.backup()`（在线、只读、与 WAL 并存）拷贝 `deerflow.db`，绝不直接复制可能处于半写状态的 `.db`/`-wal`。`postgres` → `database_included=false` 并在 manifest 写「用 `pg_dump` 承担」；`memory` → 无库。
- **D4 导入是离线操作**：仅 CLI（**不加 HTTP 导入端点**——覆盖正在使用的库是脚枪）。目标非空默认拒绝，`--force` 才覆盖；`--dry-run` 只报告将发生什么。恢复时若库文件被占用（Windows `os.replace` 失败）→ 明确报错。
- **D5 排除项 = 瞬态 + 派生**：`locks`（N8 跨进程锁，瞬态）、`retrieval`（memory 派生检索索引，可重建）**默认不入包**，在 manifest 的 `excluded` 里带原因。其余目录默认入包。
- **D6 资产是操作员自有、opt-in**：`assets.roots`（N9，默认空）不在 `base_dir` 内，可能很大。默认**不打包**；`--include-assets` 才逐 root 加入 `assets/<idx>/` 并记录原始路径映射。恢复时需 `--assets-dest <dir>`（跨机绝对路径不同，不猜），缺失则**报告为跳过**而非静默。
- **D7 恢复按逻辑名映射回当前配置路径**：用 `DataDir.name → 当前 Paths 的该目录` 映射（`database` 特例映射到 `DatabaseConfig.sqlite_path`），因此 `base_dir` 变了也正确。
- **D8 `format_version` 是硬门，版本漂移是警告**：`BACKUP_FORMAT_VERSION` 不支持 → **拒绝导入**（写入格式可能是本进程不认识的）。`config_version` / `schema_head` 与当前不一致 → **警告**（alembic 启动自动迁移；`config-upgrade` 处理配置），不拒绝。归档头比本进程新时 alembic 会自行大声失败，manifest 记录 head 以便诊断。
- **D9 无新配置段、不 bump `config_version`**：备份是操作员动作，参数由命令行给；归档格式版本由 `BACKUP_FORMAT_VERSION` 独立表达，不混进配置 schema。
- **D10 无迁移、无新表**：归档是文件，不落库。
- **D11 API 只读、additive**：`GET /api/backup` 返回一次备份的**计划**（included / excluded / database / assets 状态）。不加写端点。前端零改动。
- **D12 CLI 可进 CI**：`python -m deerflow.portability export|import|inspect`，`--json`；退出码 `0` 成功 / `1` 拒绝（目标非空、格式不支持、不安全归档）/ `2` 自身错误。
- **D13 不加依赖**：`zipfile` + `sqlite3` + `json` 全部标准库。
- **D14 安全**：解包拒绝绝对路径、`..`、以及符号链接条目（zip 符号链接位）；写入前不信任 `manifest.json` 里的路径。

## 4. 步骤

### S1 归档模型（纯）
- 新 `deerflow/portability/`（harness 包，与 `environment/`/`apps/`/`assets/`/`resources/`/`locks/` 同级）：
  - `spec.py`：`BACKUP_FORMAT_VERSION = 1`、`ManifestEntry`、`BackupManifest`（pydantic，`extra="forbid"`；`to_dict`/`from_dict`/`load`/`dumps`）、`CompatibilityReport`、`check_import_compatible(manifest, *, current_config_version, current_schema_head) -> CompatibilityReport`（纯）。
- 验收：`tests/test_portability_spec.py`（往返 serde、非法字段拒绝、`format_version` 不支持 → 硬拒、版本漂移 → 警告、缺 manifest 必填字段报错）。

### S2 选择与计划（纯）
- `portability/select.py`：`EXCLUDED_DIRS = {"locks": "...", "retrieval": "..."}`；`plan_backup(data_dirs, *, database_backend, database_dir) -> BackupPlan`（included 带 `name`/`kind`/`source_path`/`archive_path`/`scope`/`required`；excluded 带原因）；`plan_restore(manifest, *, dir_paths: dict[str, str], database_path: str|None, target_exists: bool, force: bool, assets_dest: str|None) -> RestorePlan`（`actions` + `refusals`，纯）。
- 验收：`tests/test_portability_select.py`（locks/retrieval 被排除且带原因、archive_path 是逻辑名而非绝对路径、非空目标不 force → refusal、force → 允许、缺 assets_dest 且有资产 → 记 skipped）。

### S3 归档 I/O（安全 zip）
- `portability/archive.py`：`write_archive(dest, *, manifest, members: list[tuple[str, Path]])`（`ZIP_DEFLATED`，先写 `manifest.json`）、`read_manifest(archive) -> BackupManifest`、`extract_member(archive, member, dest)` / `extract_all(archive, dest_for: callable)`，含**路径安全校验**（拒绝绝对路径/`..`/符号链接条目/归档外路径）。
- 验收：`tests/test_portability_archive.py`（写读往返、manifest 可解析、路径穿越条目被拒、符号链接条目被拒、list 成员含 manifest）。

### S4 SQLite 一致性快照
- `portability/snapshot.py`：`snapshot_sqlite(src, dest) -> str`（`sqlite3.connect(uri=file:...mode=ro).backup(...)`，返回 sha256）、`fingerprint(path) -> str`、`sqlite_sidecars(path)`（`.db`/`-wal`/`-shm`）。
- 验收：`tests/test_portability_snapshot.py`（建一个含表+行的库，快照后可打开且内容一致、源被打开写时快照仍一致、sha256 稳定、非 sqlite 文件报错）。

### S5 服务 + CLI
- `portability/service.py`：`export_backup(config, output, *, include_assets=False) -> dict`、`inspect_backup(config, archive) -> dict`、`import_backup(config, archive, *, force=False, dry_run=False) -> dict`（组合 S1–S4；所有 I/O 集中于此）。
- `portability/__main__.py`：`python -m deerflow.portability export --output <zip> [--include-assets] [--json]` / `import --input <zip> [--force] [--dry-run] [--assets-dest DIR] [--json]` / `inspect --input <zip> [--json]`，退出码见 D12。
- 验收：`tests/test_portability_service.py`（导出→导入往返到新 base_dir、排除项不入包、非空目标拒绝/force 覆盖、postgres 记录 `database_included=false`、assets opt-in 与 restore skip）、`tests/test_portability_cli.py`（退出码 0/1/2、`--json` 结构、inspect 无副作用）。

### S6 只读端点 + 文档 + 全量回归 + 提交
- `app/gateway/routers/backup.py`：`GET /api/backup`（把 `plan_backup` + 目录体检转成 dict，经 `asyncio.to_thread` 离开事件循环）；`routers/__init__.py` 导出；`app.py` 注册。
- 文档：根 `AGENTS.md`（工作流子系统附近补 `../portability/` 条目）、`backend/AGENTS.md`（新节 + Routers 表 `Backup` 行 + 数据目录/迁移说明）、`HNFlow 开发规划.md`（N11 行收口 ▶ ✅、P1 第 7 项、M4 行、切片 8 注）。
- 验证：`tests/test_backup_routes.py`；`ruff check` + `format --check` 全绿；全量离线回归（**N11 基线 75 failed / 10650 passed / 104 skipped**，本切片预期同 75 既有平台失败 + 新增全绿）；前端 `pnpm test`/`check` 零改动守门。
- 提交：`feat(portability): N11b 数据备份/导出导入/换机迁移（归档 + 一致快照 + 只读计划端点）` + 跟踪归档小提交。

## 5. 验证策略

- TDD：每步先写测试。命令：`cd backend` + `$env:PYTHONPATH="."` + `.venv\Scripts\python.exe -m pytest <files> -q -p no:cacheprovider`。
- **不依赖真实大文件**：用 tmp 目录造小目录树 + 小 sqlite 库。
- 跨平台：路径用 `pathlib`，断言相对逻辑名而非绝对路径；符号链接条目测试在不支持 symlink 的平台跳过（Windows 需权限）。
- 默认行为回归：**不调用新 CLI / 不访问新端点时逐字节保持现状**（专项 + 全量佐证）。
- 安全用例必测：`..`/绝对路径/符号链接条目被拒。

## 6. 开放问题（已按建议裁决）

- **Q1 归档格式**：单文件 zip + 根 `manifest.json`，逻辑布局 `dirs/<name>/`、`database/<file>`、`assets/<idx>/`？（建议：是——一个文件便于搬运；逻辑名保证跨机。）
- **Q2 恢复语义**：目标非空默认拒绝，`--force` 覆盖，`--dry-run` 预览；导入仅 CLI（离线），不加 HTTP 导入端点？（建议：是——覆盖运行中的库是脚枪。）
- **Q3 库快照**：sqlite 用 `Connection.backup()` 一致性快照；postgres 库内容由 `pg_dump` 承担（归档记录 `database_included=false`）？（建议：是——复制 `.db` 会得到半写状态。）
- **Q4 切片划分**：一个切片含导出 + 导入 + CLI + 只读预览端点；不做加密/增量/云同步/HTTP 导入/前端？（建议：是。）
