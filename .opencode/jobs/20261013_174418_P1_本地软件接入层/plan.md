# P1 — 本地专业软件接入（切片 1：N4 + N5）执行计划

> 依据《HNFlow 开发方案》§17（本地专业软件接入层）、§6.7（app 节点）、§9（工具网关 app provider）、《HNFlow 开发规划》§五 P1。
> 状态：**已完成（切片 1 全部 S1–S7）**。提交：S1/S2 `c8f958f`、S3/S4 `76a00a6`、S5（Gateway/注入）、S6 `a471a77`、S7（文档/回归）。

## 1. 目标与范围

P1 共 7 项（N4–N11）。本计划只覆盖**切片 1 = N4 本地软件接入层 + N5 `app` 类节点**，这是其余项（N6 长期实例 / N7 触发调度 / N8 资源 / N9 资产 / N10 共享工作区 / N11 探测迁移）的地基。其余项各自独立计划 + 独立小步提交。

切片 1 完成态：本地软件可被**注册**（安装路径/版本/驱动方式）、被 `app:launch` **拉起或附加**、被 `app:script` **脚本驱动**、被 `app:wait` 等待、被 `app:collect` 回收产物；AI 节点可经工具网关 `app` provider 调用已注册应用操作。

## 2. 现状调查（可复用 surface / 缺口）

**可复用**
- 节点注册链：`workflow/schema.py::NodeType` → `workflow/executors/__init__.py::build_default_registry` → `workflow/registry.py::ExecutorRegistration`（`idempotent` / `requires_confirmation`）。执行器统一签名 `(runtime, params, inputs) -> outputs`。
- 工具网关：`workflow/tool_gateway.py` 已有 `ToolDescriptor` + `ToolProvider` 协议 + `StaticToolProvider` + `build_default_tool_gateway`（sandbox/builtin）。新增 `app` provider 是**增量**，不改节点执行体。
- 危险节点：`workflow/danger.py::_DANGEROUS_TYPES`（现为 bash/http）→ `pending_review_nodes`；`registry.crash_confirm_required`。
- 运行期上下文：`workflow/compiler.py::WorkflowRuntime.context`；`runtime/runs/worker.py::_build_runtime_context` 注入 Gateway 单例（先例：`WORKFLOW_RUNTIME_CONTEXT_KEY`、skill/nitifier 钩子）。app 会话管理器走同一注入方式。
- 配置先例：`config/acp_agents.py`（外部进程 `command/args/env/timeout`）、`plugins`、`tools`——`AppConfig` 加 `apps:` 段 + `STARTUP_ONLY_FIELDS` 注册（`config/reload_boundary.py`）。
- 持久化先例：`persistence/workflow_definitions/`、`human_tasks/`（表 + alembic 迁移 + repository）。HEAD 迁移 = `0016_drop_feedback_table`。
- Gateway 路由先例：`app/gateway/routers/workflow_routes.py` 等。
- 前端节点目录：`frontend/src/core/workflows/canvas/{node-catalog.ts,types.ts,validation.ts,node-form-schema.ts}`、`components/workspace/workflows/workflow-palette.tsx`。
- 沙箱：`sandbox/`（`tool:bash` 强制走 sandbox）。**app 驱动是宿主进程，不走容器沙箱**（见决策 3）。

**缺口（全新）**
- 无任何 `app`/`app_session`/`app_registry` 概念（已 grep 全仓确认）。
- 无驱动矩阵、无实例/会话生命周期、无产物回收。
- `tool_gateway` 无 `app` provider。
- 前端无 app 类节点。

**本机实测**：`unity` 可用（`C:\Users\zhanghaonan\AppData\Local\Unity\bin\unity.exe`）；`blender`/`photoshop` 未安装。仓内已有 `unity-pipeline` / `unity-ui-prefab-creator` skill（经 Unity Pipeline HTTP API 控制 Editor）——可作为真实「应用驱动」先例。

## 3. 设计草案

### 3.1 N4 应用接入层（harness 新包 `deerflow/apps/`）
```
deerflow/apps/
  __init__.py        # 公开 API 出口
  registry.py        # AppRegistry：从 config.apps 构建；AppDefinition{name, driver, command/args/env, detect(version probe), working_dir, timeouts}
  driver.py          # AppDriver 协议：launch()/attach()/run_script()/wait()/collect()/health()/close()
  session.py         # AppSessionManager：实例/会话生命周期、就绪检测、健康检查、退出清理；单机进程内注册表
  drivers/
    cli.py           # 通用子进程 CLI 驱动（可离线测：跑一次性命令/脚本，捕获 stdout/exit/产物路径）
    mock.py          # 测试/演示驱动（回显 + 写产物，供 CI 离线断言）
  # unity.py 本切片跳过（用户决定）：Unity Pipeline 需 Editor 附加项目，后续切片再加
```
- `AppDefinition`：`name`（稳定 id，复用 `_ID_PATTERN`）、`driver`（`cli|mock`）、`command/args/env`、`working_dir`、`version_command`（探测）、`script`（脚本入口/参数模板）、`artifact_globs`（产物发现）、超时。
- `AppSession`：`session_id`、`app_name`、`status`（starting/ready/busy/crashed/stopped）、`pid`/`endpoint`、`created_at`/`last_active`、产物目录。进程内注册表 + 可选 DB 持久化（切片 1 先内存，DB 表随 N6）。
- **人机共享**：会话区分 `exclusive|shared`，附加已有实例（`attach`）优先；本切片只落地 `attach` 探测 + `exclusive` 默认（抢占/冲突检测归 N10）。

### 3.2 N5 app 节点 + 工具网关 app provider
新增 4 个节点类型（`NodeType`）：
| 节点 | 输入(默认) | 输出(默认) | params | 说明 |
|---|---|---|---|---|
| `app:launch` | `in:data` | `session:data`, `out:data` | `app`,`mode(launch\|attach)` | 启动/附加实例，输出会话句柄 |
| `app:script` | `session:data`, `in:data` | `out:data` | `app`,`script`,`args` | 经驱动执行脚本接口 |
| `app:wait` | `in:data` | `out:data` | `app`,`for(render\|compile\|idle)`,`timeout` | 等待应用内任务完成 + 健康检测 |
| `app:collect` | `session:data`,`in:data` | `out:file` | `app`,`globs` | 回收产物，写回端口 |

- 执行器 `workflow/executors/app.py`，签名与其它一致；会话管理器经 `runtime.context[APP_RUNTIME_CONTEXT_KEY]` 取（缺省回落进程内单例，禁止直连宿主 shell 的新路径）。
- `idempotent`：`app:script`/`app:launch` = `False` 且 `requires_confirmation=True`（与 bash/http 同列 `_DANGEROUS_TYPES` → 自动进 `pending_review_nodes`）；`app:wait`/`app:collect` = `True`。
- 工具网关：`PROVIDER_APP="app"`，`AppToolProvider` 把已注册应用的 `launch/script/wait/collect` 暴露为 `BaseTool`（AI 节点经 `allowed-tools` 装配）。**app provider 排 builtin/sandbox 之后**（命名冲突以显式声明为准）。

### 3.3 前端
`canvas/types.ts` NodeType 联合 + `NODE_CATEGORIES` 加 `app`（label "App"）+ `node-catalog.ts` 4 条 + `validation.ts`（app 类节点端口规则）+ `node-form-schema.ts`（`app` 下拉取 `/api/apps`、`script/args` 字段）。属性面板复用现有表单渲染。

### 3.4 Gateway
- `GET /api/apps`：列出已注册应用（name/driver/版本探测结果/是否可用）。
- `GET /api/apps/sessions`：列出活动会话（切片 1 内存态）。
- （N6 再扩 CRUD/恢复/归档。）

### 3.5 配置
`backend/packages/harness/deerflow/config/apps_config.py`：`AppsConfig{enabled:bool=False, definitions:list[AppDefinition]}`；`AppConfig.apps` 字段；`STARTUP_ONLY_FIELDS` 注册 `apps`（驱动进程生命周期，重启生效）；`config.example.yaml` 增注释样例（默认空/关闭）。`config_version` +1。

## 4. 决策（已确认）
1. 切片范围：**只 N4+N5**，N6–N11 各自独立计划。
2. 首批驱动：**`cli` + `mock`**（`unity` 驱动经用户决定**本切片跳过**，待后续切片再接——Unity Pipeline 需 Editor 附加项目，不在切片 1 范围）。
3. 宿主执行例外：**确认**——app 驱动运行在宿主，显式例外于「命令必须走 sandbox」。
4. 注册表存储：**`config.yaml apps:`（operator 控制）+ 运行期会话先内存（DB 随 N6）**。
5. 确认语义：**`app:launch`/`app:script` 列入危险节点**。
6. 端口命名：**按 3.2 表**（`session` 用 `data` 承载，不新增 PortType）。

## 5. 验收标准（切片 1）
- `config.yaml` 注册一个 `mock` 应用 + 一个 `cli` 应用，画布/API 可列出。
- 端到端工作流：`app:launch` → `app:script`（写产物）→ `app:wait` → `app:collect`（产物经 `file` 端口回落）可编译、执行、断点/恢复（复用 LangGraph checkpointer）。
- AI 节点经工具网关 `app` provider 可调用已注册应用操作（`allowed-tools` 显式声明；未声明则无工具，同 §7.1 边界）。
- `app:launch`/`app:script` 默认进 `pending_review_nodes`，`run_workflow` pre-flight 拦截。
- 后端 pytest 全绿（新增 `tests/test_workflow_app_*.py` + `tests/apps/`）；前端 `pnpm check`/`test` 全绿。

## 6. 测试策略（TDD，强制）
- `tests/apps/test_registry.py`（解析、幂等、缺省关闭）
- `tests/apps/test_cli_driver.py`（真子进程、超时、产物发现）
- `tests/apps/test_session.py`（生命周期/健康/清理）
- `tests/test_workflow_app_executors.py`（4 执行器 + 端口）
- `tests/test_workflow_app_tool_provider.py`（网关 provider 装配）
- `tests/test_workflow_compiler.py` 扩展（app 节点编译）
- 前端 `tests/unit/core/workflows/canvas/*`（目录/校验）。

## 7. 风险
- Windows 进程/信号差异（终止、超时）——用 `subprocess` + 进程组/`creationflags`，测试覆盖。
- 长驻 GUI 进程的「就绪」判定不稳——以驱动显式 `health()` + 超时为准，不猜。（Unity 驱动本切片跳过，此风险顺延。）
- 端口 `session` 类型：用现有 `data`（JSON 句柄）承载，不新增 `PortType`（避免 C6 式扩散；如确需再议）。
- 与 N6 的会话持久化边界：切片 1 明确「内存态、进程内」，避免半吊子持久化。

## 8. 执行顺序（确认后）
1. 配置 + 数据模型（`apps_config.py`、`apps/registry.py`、`apps/driver.py`）。
2. 驱动与当前会话管理（`cli`/`mock`/`unity`、`session.py`）+ 单测。
3. 节点类型 + 执行器 + 注册表 + danger + 工具网关 provider + 单测。
4. 编译/执行贯通（compiler 无需大改，仅注册）+ 集成测试。
5. Gateway 路由 + 运行期上下文注入。
6. 前端目录/表单/校验 + 单测。
7. 文档同步（`AGENTS.md` / `README.md` / `HNFlow 开发规划.md` 进度）+ 全量回归。
