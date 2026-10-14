# P1 切片 5：N9 文件、资产与跨软件数据契约

> 依据《HNFlow 开发方案》§20（本地文件、资产与跨软件数据契约）、《HNFlow 开发规划》§四 N9 行 / §五 P1 第 5 项。
> 状态：**已完成（S1–S8）**，提交 `269b215`。
> 前序：切片 1（N4+N5）✅、切片 2（N6）✅ `88ed02b`、切片 3（N7）✅ `de34214`、切片 4（N8）✅ `4c6a808`。

---

## 一、目标与现状差距

§20 三句话拆成三件可落地的事：

1. **本地文件/资产一等建模** —— 路径、工程文件、大二进制、监视目录、版本；`data:file` 从「读写」扩展为资产管理。
2. **跨软件数据契约** —— 工程文件/资产引用/格式/单位/坐标约定作为多软件协作接口。
3. **格式转换** —— 跨软件格式互转作为数据节点/能力包操作。

**现状（已核实）**：

| 能力 | 现状 | 差距 |
|---|---|---|
| 沙箱内文件读写 | `data:file`（`executors/data.py`，read/write，sandbox 虚拟路径） | 无 `import`/`export`/`inspect`/指纹 |
| app 产物 | `app:collect` → `SessionManager.collect` → driver 返回**宿主绝对路径** `list[str]`，端口 `artifacts`（array）+ `out`（首个） | 产物只有裸路径；无 `size`/`sha256`/`extension`；与沙箱/`present_files`（只认 `/mnt/user-data/outputs`）**不连通** |
| 资产元数据 | `app_instances.resources` 只累计计数（`artifacts` 整数） | 无逐资产记录 |
| 宿主↔沙箱搬运 | 无 | 应用产出无法进入工作流后续节点；沙箱产物无法交付给本机软件 |
| 格式/单位/坐标约定 | 无 | 无声明、无校验 |
| 格式转换 | 无（`data:convert` 只做类型转换） | 无 |
| 监视目录 | N7 `file` 触发已覆盖（`st_ctime`/`<path>:<mtime>` 去重） | ——（本切片不重做） |

**核心洞察**：app 驱动**运行在宿主**（切片 1 显式例外），`data:file`/`tool:bash` 走**沙箱**，两者之间没有通道，也没有共同的资产标识。N9 的最小可用集就是补这条通道 + 给它一个可校验的标识。

---

## 二、范围（做 / 不做）

**做**：

- A. **资产引用建模**：`AssetRef` 纯数据 + 规范 `uri` + 指纹（`sha256`/`size`/`mtime`）+ 格式契约（扩展名/media type/单位/坐标约定）校验。
- B. **`data:asset` 节点**：`inspect`（幂等）/ `import`（宿主→沙箱）/ `export`（沙箱→宿主）/ `convert`（声明式转换器，命令走沙箱）。
- C. **配置 `assets:` 段**：宿主资产根白名单（安全边界）、单文件大小上限、`converters` 声明、`contracts`（跨软件格式/单位/坐标约定）。
- D. **字节接通既有能力**：`app:collect` 追加 `assets` 输出（`list[AssetRef]`，scope=host），保留既有 `artifacts`/`out` 不变。
- E. **前端最小同步**（沿用 C11 约定）：节点目录/属性面板/types/校验/i18n 加 `data:asset`。
- F. **文档同步**：根 `AGENTS.md`、`backend/AGENTS.md`、`HNFlow 开发规划.md`。

**不做**（明确留待后续）：

- 资产版本库/溯源历史（只记 `source` + 指纹；「版本」= 指纹变更检测，由 N7 `file` 触发与 `inspect` 配合）。
- 真实软件格式互转脚本本体（Blender/PS/Unity headless 脚本）——`convert` 只提供**声明式**执行通道；无 converter 声明时该操作不可用。
- 资产预览/资产管理 UI（`/api/threads/{id}/artifacts/{path}` 已能取字节；GC 与磁盘配额由 N8 声明式 `disk_mb` + `app_instances` 清理覆盖）。
- 远程/HTTP 资产、资产市场、跨机同步。
- 监视目录（N7 已覆盖）、`tool:notify`。
- 新增 `PortType`（沿用切片 1 先例，资产经 `data` 端口传递）。

---

## 三、关键决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | **不新增 `PortType`**；`AssetRef` 作为 `data` 端口的 dict 负载 | 切片 1 会话端口同一先例（`data` 类型）；避免 `workflow_io.ports_compatible` + 前端 `types.ts` + 颜色映射的连锁改动 |
| D2 | **宿主往返默认关闭**：`assets.roots` 为空 ⇒ `import`/`export` 一律拒绝。启用需显式配置根目录 | 安全默认 + 向后兼容（未配置时现有行为逐字节不变，同 N8 `governor` 缺省不注入的思路） |
| D3 | **路径安全校验**：`realpath` 归一 → 必须在白名单根内；拒绝 symlink（`os.lstat` + `S_ISLNK`）/非普通文件；`export` 目标目录由白名单根推导 | 复用 `routers/artifacts.py` 既有校验风格（symlink/二进制/大小上限） |
| D4 | **`data:asset` 注册为幂等**（`inspect` 为主用途）；`import`/`export`/`convert` 在**执行器内部**要求 `crash_confirm=true`，不进 `_NON_IDEMPOTENT_TYPES` | 与 `data:file` write 完全同构（既有注释即说明此模式）；避免把资产节点打成 `pending_review` 危险节点阻塞画布装配 |
| D5 | **转换命令必须走 sandbox**（`Sandbox.execute_command`），与 `tool:bash` 同规则；宿主侧只做路径搬运 | AGENTS.md 既有铁律「命令必须走 sandbox」；app 驱动是唯一例外，不扩大 |
| D6 | **原子写入**：`import` 落沙箱用 `sandbox.write_file`；`export` 落宿主用临时文件 + `os.replace`（可 fsync） | §二十三 原则 16「原子写入」 |
| D7 | **配置启动生效**：`assets` 入 `STARTUP_ONLY_FIELDS`；`config_version` 37 → 38 | 与 `apps`/`scheduler` 一致的先例 |
| D8 | **`app:collect` 增量扩展**：新增 `assets` 输出，`artifacts`/`out` 保持原样 | 已有工作流零破坏 |
| D9 | **前端同步最小集**（与 C11 约定一致）：不做资产管理页，只让画布能放置/配置 `data:asset` | 新节点不同步会破坏画布一致性；N8 不改前端是因无新节点 |
| D10 | 单位/坐标约定**只做声明式契约 + 校验**（扩展名/media type/单位/轴序等元数据），不做数值换算 | §20 要求「作为接口」，不做几何引擎 |

---

## 四、落地设计

### 4.1 新子包 `deerflow/assets/`

- `ref.py`（纯函数，无 I/O 之外的依赖）：
  - `AssetRef`（pydantic v2, `extra="forbid"`）：`uri` / `path` / `scope`(`host|workspace|uploads|outputs`) / `size` / `sha256` / `mtime` / `extension` / `media_type` / `contract` / `source`。
  - `asset_uri(scope, path)` → `asset://host/<abs-normalized>`、`asset://workspace/<rel>`；`parse_asset_uri(uri)` 反向解析（拒绝非法 shape）。
  - `fingerprint(path_bytes) -> sha256`；`inspect_bytes(data, ...)` 供沙箱侧（只能拿字节时）复用。
  - `extension_of(path)`、`media_type_for(extension)`（小内置表，缺失 → `None`）。
  - `to_port(ref)` / `from_port(value)`（dict 往返，容错：接受裸字符串路径 → 退化为仅 `path`+`scope`）。
- `contracts.py`：`AssetContract`（`extensions` / `media_type` / `unit` / `axes` / `up_axis` / `notes`）、`AssetConverter`（`from` / `to` / `extensions` / `command` / `args` / `timeout_seconds`）、`validate_asset_against_contract(ref, contract) -> None|raise AssetContractError`（报错携带期望/实际）。

### 4.2 配置 `deerflow/config/assets_config.py`（新）

```yaml
assets:
  roots: []                 # 允许与沙箱往返的宿主根目录（空 = 禁用）
  max_bytes: 536870912      # 单文件搬运上限（512MB）
  contracts:
    blender_scene: { extensions: [".blend"], media_type: "application/x-blender", unit: "m", up_axis: "Z" }
  converters:
    fbx_to_obj: { from: ".fbx", to: ".obj", command: "assimp", args: ["export", "{in}", "{out}"], timeout_seconds: 300 }
```

- `AssetsConfig`（`extra="forbid"`）、`get_assets_config()` 单例 + `load_assets_config_from_dict`；扩展名统一小写带点校验；`roots` 归一为绝对路径；converter 名/`from`/`to` 校验。
- `AppConfig` 增 `assets: AssetsConfig`；`reload_boundary.STARTUP_ONLY_FIELDS` 加 `"assets"`；`config.example.yaml` 加注释块 + `config_version: 38`。

### 4.3 `data:asset` 节点

`schema.py`：`NodeType.DATA_ASSET = "data:asset"`。
`registry.py::_build_placeholder_registry` 加占位项（描述）。
`executors/asset.py`（新）+ `executors/__init__.py` 注册真实执行器（幂等）。

端口与参数：

| operation | 入 | 出 | 副作用门 |
|---|---|---|---|
| `inspect` | `in`(data: 路径或 AssetRef) | `out`/`asset` = AssetRef，`assets` = [AssetRef] | 无（幂等） |
| `import` | `in`(宿主路径，白名单内) | 同上（scope=workspace/uploads） | `crash_confirm=true` |
| `export` | `in`(沙箱虚拟路径) | 同上（scope=host） | `crash_confirm=true` |
| `convert` | `in`(沙箱内路径) | 同上（scope=workspace/outputs） | `crash_confirm=true` |

- `params.destination`（可选）：`workspace|uploads|outputs` 或白名单内相对子目录。
- `params.contract`（可选）：引用 `assets.contracts.<name>`，命中即校验（扩展名/media_type），不符 → `WorkflowExecutionError`（消息含期望与实际）。
- `params.converter`（`convert` 必填）：`assets.converters.<name>`；命令经 `sandbox.execute_command`，`{in}`/`{out}` 占位替换为**虚拟路径**；产物按 `to` 扩展名推导，落 `outputs`（默认）或 `workspace`。
- 沙箱获取沿用 `sandbox_tools.ensure_sandbox_initialized(runtime)`（同 `data:file`）；宿主搬运与 `sha256` 计算经 `asyncio.to_thread` 离事件循环。
- 错误统一 `WorkflowExecutionError`（可被 N7 退避/DLQ 消费）；白名单拒绝/超限/symlink 各自明确文案。

### 4.4 `app:collect` 增量

`executors/local_app.py::exec_app_collect`：把 host artifact 路径用 `deerflow/assets/ref.py` 包装为 `list[AssetRef]`（`scope="host"`，`size`/`sha256` 惰性：默认算 `size`+`mtime`，`sha256` 仅在 `params.hash=true` 时算以免 GB 级文件拖慢），新增 `"assets"` 输出；`artifacts`/`out` 原样保留。`apps/persistence.py` 的计数不改。

### 4.5 前端最小同步

- `frontend/src/core/workflows/node-catalog.ts`：`data:asset` 条目（分组 data，operation 枚举，path/destination/contract/converter/crash_confirm 字段）。
- `types.ts`（端口类型仍 `data`）/ `validation.ts`（`convert` 需 converter、`import|export` 需 crash_confirm）/ i18n（zh + en）。
- 不新增页面、不做资产管理面板。

---

## 五、步骤（S1–S8）

| # | 步骤 | 产出 | 测试 |
|---|---|---|---|
| S1 | `deerflow/assets/{__init__,ref}.py` + `contracts.py` | AssetRef/uri/指纹/契约校验纯函数 | `tests/test_asset_ref.py`（uri 往返、非法 uri 拒绝、扩展名/media_type、契约不符报错含期望实际、裸字符串宽容解析） |
| S2 | `config/assets_config.py` + `AppConfig.assets` + `reload_boundary` + `config.example.yaml`（38） | 配置模型与校验 | `tests/test_assets_config.py`（默认禁用、扩展名归一、roots 绝对化、converter 校验、`config_version` 38 升级）+ 修 `tests/test_reload_boundary.py` 既有 pin |
| S3 | `schema.NodeType.DATA_ASSET` + `registry` 占位 + `executors/asset.py` 的 `inspect` | 只读资产探查打通 | `tests/test_data_asset_executor.py::inspect` 批 |
| S4 | `import`/`export` + 白名单/symlink/大小上限 + 原子写 | 宿主↔沙箱通道 | 同上文件 import/export 批（白名单外的宿主路径拒绝、symlink 拒绝、超限拒绝、缺 `crash_confirm` 报错、导出落点原子替换、往返指纹一致） |
| S5 | `convert`（声明式 converter + 沙箱执行 + `{in}`/`{out}` 占位） | 格式转换通道 | 同上 convert 批（无 converter 声明报错、命令断言走 sandbox、产物落点、失败透传 exit code） |
| S6 | `app:collect` 追加 `assets` 输出 | app 产物成资产 | `tests/test_local_app_assets.py`（含 globs 空/多产物/`hash=true`/`artifacts` 兼容不变）+ 回归 `tests/test_workflow_app_executors.py` |
| S7 | 前端最小同步（node-catalog/types/validation/i18n） | 画布可放 `data:asset` | `pnpm test` + `pnpm typecheck` + `pnpm check` |
| S8 | 文档同步（根/backend `AGENTS.md`、规划 N9 行 ◐ + P1 第 5 项 + M4 行 + 切片 5 进度注）+ 全量回归 + ruff + 提交 | —— | 全量 `pytest -m "not live"`（基线 75 failed 平台项，无新增）+ `ruff check`/`format --check` |

依赖：S1 → S2 → S3 → S4 → S5 → S6；S7 依赖 S3–S5 的参数定稿；S8 最后。

---

## 六、验收

1. `assets.roots` 未配置时：`import`/`export` 明确拒绝，其余能力不影响现有工作流（全量回归无新增失败）。
2. 配置白名单后：宿主工程文件可 `import` 进沙箱工作区、沙箱产物可 `export` 到宿主；往返 `sha256` 一致。
3. `inspect` 产出稳定 `uri` + 指纹；同一文件二次 inspect 指纹一致，改动后指纹变化。
4. 声明 `contracts` 后，扩展名/media_type 不符的资产在执行期被拒且报错含期望/实际。
5. 声明 `converters` 后，`convert` 经沙箱产生目标格式产物；未声明转换器时操作明确不可用。
6. `app:collect` 的 `assets` 输出与既有 `artifacts`/`out` 并存，旧工作流逐字节行为不变。
7. 前端可放置/配置 `data:asset` 节点，`pnpm check` 全绿。
8. 文档已同步；`ruff` 全绿；全量离线回归与 N8 基线同量级（仅既有平台失败）。

---

## 七、风险与开放问题

| # | 风险/问题 | 处置 |
|---|---|---|
| R1 | `assets.roots` 默认空 ⇒ 功能默认不可用，用户可能觉得「没做出来」 | 有意为之（安全默认）；`config.example.yaml` 给注释示例；`GET /api/features` 是否需要报 `assets.enabled` ⇒ **待定，倾向本切片不加**（避免无谓 API 面） |
| R2 | `sha256` 对 GB 级文件耗时 | 默认只算 `size`/`mtime`；`params.hash=true`（或契约要求）才全量哈希；全部 `asyncio.to_thread` 离事件循环 |
| R3 | Windows 上白名单/symlink 语义（junction）与 POSIX 不同 | 以 `Path.resolve()`（已解析 junction）+ `lstat` 为准；测试按平台分支，与既有 Windows 先例（`msvcrt` 锁、`os.utime` 坑）一致 |
| R4 | 新节点需前端同步，工作量超出「后端切片」惯例 | 已列为 S7 最小集（无新页面）；如需完全不改前端 ⇒ 改用 `data:file` 扩展 operation（**请用户裁定**，默认按 D9 同步） |
| R5 | `convert` 依赖外部二进制（如 assimp/ffmpeg）不可用 | 声明式：无声明即不可用；执行失败透传 exit code/stderr，供 N7 退避与人工排障 |
| R6 | 是否顺带把 `data:file` 升级为资产感知 | 不做（本切片保持 `data:file` 原语义，避免既有工作流回归）；资产能力集中在 `data:asset` |
