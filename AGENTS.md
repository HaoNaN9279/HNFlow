# AGENTS.md

本文件为 AI 编码智能体（Claude Code、Codex 等）提供在本仓库工作时的指引。它是整个 monorepo 的**导览层**：负责映射全仓库结构，并把每个模块的深度细节指向模块自己的文档。凡是模块内部的问题，先读对应模块文档，不要指望本文件给出全部细节：

- **[backend/AGENTS.md](backend/AGENTS.md)** — 后端深度：harness/app 拆分、agent 与中间件链、sandbox、MCP、skills、memory、IM 渠道、持久化/迁移、配置系统、测试布局。
- **[frontend/AGENTS.md](frontend/AGENTS.md)** — 前端深度：Next.js App Router 布局、thread/流式数据流、代码风格、命令。

## HNFlow 是什么

HNFlow 是**图驱动的确定性编排引擎**。它以 DeerFlow harness（LangGraph super agent 底座）为内核，在其上叠加一层「工作流定义/编译层」，把 DeerFlow 全部现有能力（Skills、MCP、Sandbox、Checkpointer、Interrupt、Subagent）降为节点的执行底座，不推倒重来。

- **双入口**：工作流画布（React Flow 可视化编辑）+ AI 对话（lead agent 自然语言驱动）。两者控制同一运行生命周期，行为一致。
- **执行模型**：确定性与自主性并存——流程型任务走工作流图（节点执行、端口数据流、断点续跑、人工挂起），自由任务走现有对话；goal loop / plan mode 保留为「图中的一个 AI 节点」。
- **核心理念**：`WorkflowDefinition` 是纯 JSON（可序列化），经 `compiler` 编译为 LangGraph `StateGraph`（可执行）。可序列化由定义层保证，可执行/断点/挂起全部复用 LangGraph 原生语义。

### 工作流执行模型

工作流图由节点与边构成，节点按类型分六类：

- **流程控制**（`flow`）：start / end / if / switch / loop / parallel / wait / try / handoff（try 为 N12 容错容器；handoff 为 N14 §24.6a 受控动态 handoff）。
- **数据操作**（`data`）：assign / convert / file / json / regEx / shared（N14 共享工作区黑板）/ knowledge（N14 本地知识检索：ingest / retrieve + 引用）。
- **工具调用**（`tool`）：bash / http / notify / log / invoke——bash 必须走 sandbox，禁止直连宿主 shell；`tool:invoke`（§25 工具节点化）直接用图调用网关里的**任意**工具（sandbox/builtin/app），非幂等 + crash-confirm 门（见下）。
- **AI 节点**（`ai`）：llm_agent，三层提示词组装 + 受限 SubagentExecutor，非自由 ReAct loop；可声明自主度档位与硬预算（N14 §24.5）。
- **本地应用**（`app`）：launch / script / wait / collect——经应用接入层（`deerflow/apps/`）驱动本机专业软件，**运行在宿主**（GUI/长驻进程无法进沙箱），是「命令必须走 sandbox」的显式例外。
- **人工与嵌套**（`human` / `nested`）：human_task 表单挂起、human_review 审批/拒绝回跳、subworkflow 子图/委派。

端口数据经 state 字段流转（命名 `wf:<node_id>:<port>`），由 compiler 绑定，节点执行函数与 state 解耦。断点续跑、人工挂起、取消、SSE 节点级事件全部复用 LangGraph/DeerFlow 既有 run 生命周期，不新写执行循环。

## 服务拓扑

一次 `make dev` / Docker 栈运行四个协作服务：

| 服务 | 端口 | 角色 |
| --- | --- | --- |
| **Nginx** | `2026` | 统一反向代理入口——浏览器打开这个 |
| **Gateway API** | `8001` | FastAPI REST API + 内嵌 LangGraph 兼容 agent 运行时 |
| **Frontend** | `3000` | Next.js Web 界面 |

Nginx 是唯一公共入口：它托管前端，并把 `/api/langgraph/*` 代理到 Gateway 的 LangGraph 运行时（重写为 Gateway 原生 `/api/*` 路由）；其余 `/api/*` 直通 Gateway 的 REST 路由。运行时与路由细节见 [backend/AGENTS.md](backend/AGENTS.md)。Nginx 压缩 HTML 与已配置的文本资源，代理层刻意保留 SSE、字体、图片、音频、视频不压缩。

两份 compose 文件把该入口发布为 `"${BIND_HOST:-127.0.0.1}:${PORT:-2026}:2026"`——**默认回环绑定**，与 README 记录的部署模型一致。裸写 `"${PORT}:2026"` 会绑定 `0.0.0.0`，不符合默认。Nginx 自身监听 IPv4+IPv6 的 `default_server`，Gateway 在容器内有意绑定 `0.0.0.0:8001`——两者都是容器内部行为；对外只暴露 Nginx 端口，Gateway 的 `8001` 刻意不发布。任何新增发布端口都需要显式绑定地址；`backend/tests/test_compose_default_bind_host.py` 为两份 compose 文件里每个服务钉死该约束。

## 仓库地图

```
HNFlow/
├── Makefile                        # 根编排：驱动整个栈（dev/start/stop、docker、setup）
├── config-examples/                # 已提交的配置模板（config/prompts/capability-groups/tools/workflows/model-profiles）
├── config.example.yaml             # 主配置模板，由 make config 播种到 hnflow-data/config.yaml
├── extensions_config.example.json  # MCP/skills 模板，播种到 hnflow-data/extensions_config.json
├── hnflow-data/                    # 唯一用户数据根（gitignored）：配置、提示词、能力组、工具、skills、DB、工作区/工作流实例
├── backend/                        # Python 后端——见 backend/AGENTS.md
│   ├── Makefile                    # 后端模块命令（dev、gateway、test、lint、format、migrate-rev）
│   ├── packages/extension-api/     # deerflow-extension-api 包（import: deerflow_extension_api.*）——公共扩展契约
│   ├── packages/harness/           # deerflow-harness 包（import: deerflow.*）——agent 框架
│   └── app/                        # FastAPI Gateway（import: app.*）
├── frontend/                       # Next.js 前端（pnpm）——见 frontend/AGENTS.md
├── docker/                         # docker-compose 文件、nginx 配置
├── skills/                         # 产品内置 skills：public/（已提交模板）；运行时副本播种到 hnflow-data/skills/public/
├── contracts/                      # 跨组件 JSON 契约（如 subagent 状态、skill review）
├── scripts/                        # Makefile 调用的根编排脚本（check、configure、doctor、support_bundle、serve、nginx、docker、deploy、setup_wizard）
├── tests/                          # 根级测试（当前为 tests/skills/——public skill 测试）
└── docs/                           # 跨切文档、计划与设计笔记
```

### 工作流子系统（workflow/）

HNFlow 的核心新增层，位于 `backend/packages/harness/deerflow/workflow/`。定义层与执行层解耦：数据模型不引入 LangGraph 依赖，保证纯 JSON 可序列化。

- `schema.py` — 节点/边/端口类型定义（Pydantic v2）：`PortType` 含 `data/file/bool/enum/number/array/record/spec`；`Node` 含 `agent_name` 主身份绑定与 `capability_groups`。节点类型含 `data:schema`（静态输出 Schema 提供者）、`data:spec`（规约生命周期）与 `verify:gate`（三值验证门禁）；`data:knowledge` 已删除。
- `workflow_io.py` — `validate_definition`：无环 DFS、单起点单终点、端口类型匹配、**同一输入端口只允许一条入边**（`flow:end` 与 `flow:loop` 除外）、Schema 节点边校验、`verify:gate` 三分支（`verified` / `failed` / `inconclusive`）必须全部接线。`serialize`/`deserialize` 带 schema version 迁移链。
- `spec.py` / `verification.py` — 规约引用（`SpecRef`）、不可变规约修订（draft/frozen/superseded）、检查结果三值（verified/failed/inconclusive）与结构化诊断。`spec` 端口只传引用，正文由持久化修订解析。
- `verifiers/` — `spec_lint`、`mock_verifier`、`dafny_verify`、`tla_model_check`、`lean_check`、`cel_evaluate`（后者当前显式 inconclusive）。验证器 CLI 一律经 sandbox 执行，工具描述符声明只读/确定性，节点不要求 `crash_confirm`。
- `executors/spec.py` / `executors/verify.py` — `data:spec` 的 create/revise/freeze/resolve/lint；`verify:gate` 经 ToolGateway 调 verifier，按 `status` 路由三值分支，缺失 spec/工具 fail-loud，验证器超时/崩溃/坏输出为 `inconclusive`。
- `compiler.py` — 定义 → LangGraph。端口绑定 `wf:<node_id>:<port>`；节点生命周期事件；loop/try/handoff 原生展开；共享工作区；自动资源锁；编译缓存；`verify:gate` 三值条件路由与 `wf:<node>:__verification` 保留通道。**已删除 fan-in `params.merge`**；AI 节点通过 `input_schema` / `output_schema` 输入解析同一个 `data:schema` 节点，AI→AI 交付边两侧 Schema 节点必须一致。
- `worker.py` — 编排入口，复用 RunRecord/checkpointer/run events；`runtime_context.py` 是唯一 compile/runtime context 装配点。
- `model_profiles/` + `0023_model_profiles` — AI 节点只写 `params.model_profile`；profile 只指向 `config.yaml -> models[]` 实际模型；未知/停用/目标缺失 fail-loud；`/api/model-profiles` CRUD；`GET /api/models` 仍只读。
- `context_compression.py` — 自动上下文压缩：预算来自所选模型 `context_window`，压缩阈值/尾部保留由内部常量计算；压缩提示词为内置 skill；复用 `DeerFlowSummarizationMiddleware`；所有 `ai:llm_agent` 默认启用，无节点参数、无前端可见消息。
- `executors/ai.py` — AI 节点：身份 + 能力 + `template_prompt` 任务；无 `instruction`、`autonomy`、`context_policy`、`memory`、`retrieval`、`model_policy`；不做子 Agent 调用；不注入 token 预算；输入/输出 Schema 来自 `__input_schema` / `__output_schema`；`out` 为 AI Result Envelope；保留 token usage/stop_reason/prompt 观测通道。
- `executors/` — `flow.py` / `data.py` / `asset.py` / `tool.py` / `local_app.py` / `human.py` / `review.py`。`data:file`、`data:asset`、`app:script` 默认启用失败回滚，无节点开关。
- `prompts.py` — 提示词桶：identity / capability / capability_rules / capability_skills / specification / schema_contract / task / schema。`task` 只来自 `template_prompt`；`specification` 由 AI 节点的 `spec` 输入解析冻结规约后注入；`schema_contract` 是 HNFlow 内置通用字段规则。已删除 examples/context 桶。
- `prompt_preview.py` — 静态预览同一套桶；`template_prompt` 是 runtime omitted；`input_schema` / `output_schema` 均来自 `data:schema` 节点。
- `structured_output.py` — AI Result Schema 解析/校验/修复核心：固定通用字段 + 自定义字段、AI Result Envelope、`[schema.*]` 引用；`INPUT_SCHEMA_PORT="input_schema"`、`OUTPUT_SCHEMA_PORT="output_schema"`。
- `patterns.py` / `handoff.py` / `definition_evals.py` / `eval_runner.py` / `evals.py` / `replay.py` / `budgets.py` / `costs.py` / `reliability.py` / `breakpoint.py` / `delegate.py` / `dispatch.py` / `human_task_state.py` — 模板、动态 handoff、评测、回放、运行级预算、成本、幂等、断点、委派与对话调度。运行级 `metadata.budget` 仍保留，AI 节点级 token 预算已删除。
- `compensation.py` / `undo.py` / `undo_service.py` — 失败回滚与撤销。`rollback_on_failure` 不再暴露；支持的执行器默认备份/回滚。
- `../apps/` — 本地应用接入层（N4/N5/N6/N8/N10b）。
- `../assets/` — `AssetRef` + 资产契约。
- `../environment/` — 环境探测与数据目录。
- `../portability/` — 备份/导出导入。

### 扩展与运行时配置

第三方扩展从 `config.yaml` 顶层 `plugins:` 列表加载（运营商有意控制——该列表会导致代码被导入，因此刻意不放入 API 可写的 `extensions_config.json`）。见 [backend/AGENTS.md](backend/AGENTS.md) 的扩展系统一节。

### 统一用户数据目录（hnflow-data/）

所有用户可配置内容与用户数据统一放在仓库根 `hnflow-data/`，该目录整体 gitignored：

```text
hnflow-data/
├── config.yaml / extensions_config.json / .env / frontend.env
├── prompts/lead-agent.md
├── capability-groups/
├── tools/
├── skills/
├── data/deerflow.db
└── users/{user_id}/threads/{thread_id}/...
```

- 规范根变量是 `HNFLOW_HOME`；`DEER_FLOW_HOME` 继续作为兼容别名。
- 主配置解析顺序：显式 `DEER_FLOW_CONFIG_PATH` → `$HNFLOW_HOME/config.yaml` → 旧仓库根/backend 位置。
- SQLite 的相对 `sqlite_dir` 按统一根解析；默认 `data`。
- 工作流实例以 `thread_id` 标识，实例文件在 `users/{uid}/threads/{tid}/`；工作流定义、模型档案等事务数据在 `data/deerflow.db`。
- Lead Agent 提示词优先读 `prompts/lead-agent.md`，兼容旧 `SOUL.md`。
- `capability-groups/`、`tools/` 的公共根从 `$HNFLOW_HOME` 派生；用户级能力组仍在 `users/{uid}/capability-groups/`。
- 案例/模板保留在 `config-examples/`，`make config` 只复制缺失文件，不覆盖用户配置。
- `make data-migrate`（`DRY=1` 预览）把旧位置复制进统一根，不删除旧文件。

配置 schema 与解析顺序见 [backend/AGENTS.md](backend/AGENTS.md)。

## 命令：根 vs 模块

**根 `make` 目标驱动整个栈**（在仓库根运行）：

```bash
# 安装与诊断
make setup            # 交互式安装向导（新用户推荐）
make doctor           # 检查配置与系统要求
make support-bundle   # 生成脱敏排障摘要、AI issue 草稿与可选 zip
make config           # 从 config-examples/ 播种 hnflow-data/（config 已存在则中止）
make config-upgrade   # 将 config.example.yaml 的新字段合并进 hnflow-data/config.yaml
make data-migrate     # 把旧配置/数据复制进 hnflow-data/（DRY=1 预览）
make check            # 检查所需工具是否已安装
make install          # 安装全部依赖（frontend + backend + pre-commit hooks）
make setup-sandbox    # 预拉 sandbox 容器镜像（可选但推荐）

# 启动与停止
make dev              # 热重载启动全部服务（Gateway + Frontend + Nginx）
make dev-daemon       # dev 后台模式
make start            # 本地生产模式启动（优化、无热重载）
make start-daemon     # start 后台模式
make nginx            # 单独前台启动 nginx（本地 dev 配置）
make stop             # 停止全部服务
make clean            # 清理进程与临时文件

# Docker 开发环境
make docker-init      # 拉取 sandbox 镜像并安装依赖
make docker-start     # 启动 Docker 开发服务（模式取自 config.yaml，浏览器 localhost:2026）
make docker-stop      # 停止 Docker 开发服务
make docker-logs / docker-logs-frontend / docker-logs-gateway / docker-logs-redis  # 查看日志

# Docker 生产栈
make up               # 构建并启动生产 Docker 栈（浏览器 localhost:2026）
make down             # 停止并移除生产容器

# 静态盘点
make detect-thread-boundaries  # 盘点 backend executor/thread/event-loop 边界
make detect-blocking-io        # 盘点可能阻塞事件循环的阻塞 IO
```

Docker 日志与重启命令在执行 Compose 前从当前 checkout 解析 `DEER_FLOW_ROOT`，与 start/stop 命令一致。完整列表运行 `make help`。

**模块命令驱动单个模块**（在模块内运行）：

```bash
# 后端（完整清单见 backend/AGENTS.md）
cd backend && make install            # 安装后端依赖
cd backend && make dev                # Gateway API 热重载（端口 8001）
cd backend && make gateway            # 仅启动 Gateway API（端口 8001）
cd backend && make test               # 离线后端测试套件
cd backend && make lint               # ruff check
cd backend && make format             # ruff format
cd backend && make migrate-rev MSG="..."  # 自动生成新 alembic revision

# 前端（完整清单见 frontend/AGENTS.md）
cd frontend && pnpm dev               # Turbopack 开发服务器（端口 3000）
cd frontend && pnpm build             # 生产构建
cd frontend && pnpm check             # lint + 类型检查（提交前必跑）
cd frontend && pnpm test              # 单元测试
cd frontend && pnpm test:e2e          # Playwright E2E 测试
cd frontend && pnpm typecheck         # 仅 TypeScript 类型检查
```

经验法则：**根 `make` = 整个应用**；**`backend/Makefile` 与 `frontend/`（pnpm）= 模块内工作**。

宿主侧 pnpm 消费者（根/frontend Makefile 与本地诊断脚本）必须经 `scripts/pnpm.py` 运行。诊断脚本先把 runner 与前端目录解析为绝对路径再切换子进程工作目录，保持与调用方当前目录无关。该 runner 优先直接 `pnpm`/`pnpm.cmd`，回退 `corepack pnpm`，并从 `frontend/` 调用以让 Corepack 遵循该项目钉定的包管理器版本。

## 下一步去哪

- 后端工作 → **[backend/AGENTS.md](backend/AGENTS.md)**
- 前端工作 → **[frontend/AGENTS.md](frontend/AGENTS.md)**
- 安装与环境搭建 → **[Install.md](Install.md)**
- 项目概览与使用 → **[README.md](README.md)**
- 发版流程 → **[RELEASING.md](RELEASING.md)**

## 工具层（能力组引用的第一层）

工具与能力组是两层：能力组只引用工具，不拥有工具定义。

- **自定义工具包**：`hnflow-data/tools/<name>/<version>/tool.json`（本地受信任代码；模板在 `config-examples/tools/`）。工具包用 `guid + version` 稳定标识，provider 支持 `python` / `mcp` / `builtin` / `sandbox` / `app`；实现见 `backend/packages/harness/deerflow/tools/packages.py`。
- **统一工具 ID**：`tool:<guid>@v<version>`、`mcp:<server>:<tool>`、`builtin:<name>`、`sandbox:<name>`、`app:<name>`。由 `deerflow/tools/registry.py` 解析。
- **能力组引用**：`hnflow-data/capability-groups/<name>/<version>/group.json` 增加 `tools` 与可选 `tool_permissions`。`resolve_capability_tools` 加载能力组闭包、解析工具引用、执行权限裁决；显式声明的工具缺失或越权时 fail-loud，不静默降级。
- **MCP**：server 配置仍在 `extensions_config.json`；MCP provider 为每个工具记录 `mcp:<server>:<tool>` 元数据，能力组只引用工具 ID，不复制 transport/凭证。
- **API**：`GET /api/tools` 返回统一工具目录（自定义包 + provider 工具），供能力组管理页选择引用。

## 跨切约定

以下约定适用于全仓库；模块细节由各模块文档负责。

- **文档同步策略** — 保持文档与代码同步：用户可见变更更新 `README.md`，开发/架构变更在同一变更集内更新相关 `AGENTS.md`。
- **测试驱动开发** — 功能与 bug 修复必须带测试。后端测试位于 `backend/tests/`（TDD 为强制要求，见 [backend/AGENTS.md](backend/AGENTS.md)）；前端测试位于 `frontend/tests/`。
- **提交前格式化** — 运行 `make format`（后端）/ `pnpm check`（前端）。后端 CI 强制 `ruff format --check`，push 前格式化必须干净。
