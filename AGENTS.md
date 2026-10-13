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

工作流图由节点与边构成，节点按类型分五类：

- **流程控制**（`flow`）：start / end / if / switch / loop / parallel / wait。
- **数据操作**（`data`）：assign / convert / file / json / regEx。
- **工具调用**（`tool`）：bash / http / notify / log——bash 必须走 sandbox，禁止直连宿主 shell。
- **AI 节点**（`ai`）：llm_agent，三层提示词组装 + 受限 SubagentExecutor，非自由 ReAct loop。
- **人工与嵌套**（`human` / `nested`）：human_task 挂起、subworkflow 子图/委派。

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
├── config.example.yaml             # 模板 → 复制为仓库根 config.yaml（gitignored）
├── extensions_config.example.json  # 模板 → 复制为 extensions_config.json（gitignored）：MCP servers + skills
├── backend/                        # Python 后端——见 backend/AGENTS.md
│   ├── Makefile                    # 后端模块命令（dev、gateway、test、lint、format、migrate-rev）
│   ├── packages/extension-api/     # deerflow-extension-api 包（import: deerflow_extension_api.*）——公共扩展契约
│   ├── packages/harness/           # deerflow-harness 包（import: deerflow.*）——agent 框架
│   └── app/                        # FastAPI Gateway（import: app.*）
├── frontend/                       # Next.js 前端（pnpm）——见 frontend/AGENTS.md
├── docker/                         # docker-compose 文件、nginx 配置
├── skills/                         # Agent skills：public/（已提交）、custom/（gitignored）
│                                    # 托管集成 skill 包全局位于 .deer-flow/integrations/skills/{provider}/
│                                    # 集成凭据与启用状态保持按用户隔离
├── contracts/                      # 跨组件 JSON 契约（如 subagent 状态、skill review）
├── scripts/                        # Makefile 调用的根编排脚本（check、configure、doctor、support_bundle、serve、nginx、docker、deploy、setup_wizard）
├── tests/                          # 根级测试（当前为 tests/skills/——public skill 测试）
└── docs/                           # 跨切文档、计划与设计笔记
```

### 工作流子系统（workflow/）

HNFlow 的核心新增层，位于 `backend/packages/harness/deerflow/workflow/`。定义层与执行层解耦：数据模型不引入 LangGraph 依赖，保证纯 JSON 可序列化。

- `schema.py` — 节点/边/端口类型定义（Pydantic v2）：`Port`、`Node`、`Edge`、`WorkflowDefinition`。`PortType` 含 `data/file/bool/enum/number/array/record`（严格同类型匹配）。`Node` 含 `agent_name` 主身份绑定（`None` = 默认 lead 身份）与 `capability_groups`（能力供给组，allowed-tools 并集 + rules 并入 prompt）。`WorkflowMetadata` 含 `resolved_groups`、`pending_review_nodes` 与 `lockfile`（全量能力快照）。`id` 校验为稳定标识（uuid/slug），禁止路径字符。`collect_resolved_groups`（解析）+ `validate_capability_groups`（存在性校验）为纯函数。
- `workflow_io.py` — 定义校验器 + JSON 序列化：`validate_definition`（无环 DFS、单起点单终点、端口类型匹配，报错携带完整环路路径 `A→B→C→A`）、`serialize`/`deserialize`（schema version + `register_migration`/`_migrate_schema` 逐版本迁移链）。纯函数，前端画布复用同一套端口匹配规则。
- `compiler.py` — `compile_definition(def, context) -> CompiledStateGraph`：节点映射为 LangGraph 节点函数，边映射为普通边/条件边；端口→state 字段绑定（`wf:<node_id>:<port>`）；每个节点函数被包一层生命周期事件发射（`wf:node:started|completed|failed` 自定义事件，携带 `depth`，顶层为 0）；子图展开（嵌套 StateGraph，边界 `_copy_on_write` 浅复制）；编译产物按 definition 哈希缓存，变更自动失效。
- `worker.py` — 编排入口：接收 definition id + 输入参数，调 compiler 编译，`graph.astream(..., stream_mode=["updates","custom"])` 执行；消费 compiler 的节点级自定义事件（仅 `depth == 0`）转 `wf:node:started|completed|failed` 到 SSE bridge + run events，`updates` 分块提供无 checkpointer 路径的 run.end 兜底；复用 run 生命周期（RunRecord、checkpointer、run events）。
- `executors/` — 节点执行器，统一签名 `executor(runtime, params, inputs) -> outputs`：
  - `flow.py` — if/switch/loop/parallel/wait 流程控制（loop 输出端口补写 `iteration`/`out`）。
  - `data.py` — assign/convert/file/json/regEx 数据操作。
  - `tool.py` — bash/http/log/notify 工具节点；bash 必须走 sandbox（`Sandbox.execute_command`），禁止直连宿主 shell；notify 经 `runtime.context["notifier"]` 钩子（缺省回落日志）发出本机通知。
  - `ai.py` — AI 节点模板模式：三层提示词组装 + 受限 SubagentExecutor；工具集 = 关联能力包 `allowed-tools` 并集，经 `tool_gateway.resolve_capability_tools` 装配（有序去重），`instruction` 模板必填。
  - `human.py` — HumanTask 挂起。
- `tool_gateway.py` — 工具网关最小版：`ToolDescriptor` + `ToolGateway`（provider 优先级分派）+ builtin/sandbox provider，`resolve_capability_tools` 供 AI 节点装配工具；MCP/skill/app provider 为后续增量。
- `prompts.py` — 三层提示词组装器：身份层（custom agent SOUL）→ 能力层（功能组工具描述 + rules + allowed-tools 并集）→ 任务层（节点 instruction 模板，支持 `{{port}}` 插值）。纯函数。
- `registry.py` — 节点执行器注册表（type → executor），含幂等标注（`idempotent`）；`requires_confirmation` 仅 `tool:bash`/`tool:http`（crashConfirm 钩子），AI/人工/嵌套节点非幂等但以 interrupt/有界自主为确认边界。
- `delegate.py` — 运行期委派：subworkflow 节点的增强版 task_tool 模式，委派子工作流 agent 执行，结果回写端口；子代理 `checkpointer=True`。
- `dispatch.py` — 对话侧调度：`run_workflow`/`pause_workflow`/`resume_workflow`/`cancel_workflow`/`get_workflow_run`/`list_human_tasks` 等 builtin 工具，经 Gateway 运行单例（`runtime.context[__workflow_runtime]`）与画布共用同一 run 生命周期，非旁路；失败时聚合 `wf:node:*` 事件给出修复信息。
- `human_task_state.py` — HumanTask 状态模型与状态机（`pending → submitted / skipped / reopened / expired`），提交后按 `output_spec` + `validation_rules` 校验。
- `dependency_graph.py` — 统一依赖图：聚合工作流→子工作流、功能组→功能组、功能组→工作流三类引用，全局 DFS 循环检测。
- `check_cycles.py` — 全局循环检测入口（CLI：`deerflow.workflow.check_cycles --definition <id>`，供 CI 与调试）。
- `danger.py` — 危险节点默认「待人工审核」标记（`tool:bash`/`tool:http` 默认写入 `pending_review_nodes` 元数据）。
- `generation_prompts.py` — `generate_workflow`/`edit_workflow` 工具的生成提示词（注入节点类型枚举、端口类型规则、命名约束）。
- `__main__.py` — CLI 入口。

### 扩展与运行时配置

第三方扩展从 `config.yaml` 顶层 `plugins:` 列表加载（运营商有意控制——该列表会导致代码被导入，因此刻意不放入 API 可写的 `extensions_config.json`）。见 [backend/AGENTS.md](backend/AGENTS.md) 的扩展系统一节。

运行时配置位于**仓库根**：复制 `config.example.yaml` → `config.yaml`（主应用配置）、`extensions_config.example.json` → `extensions_config.json`（MCP servers + skills）。两个真实文件均 gitignored，可在运行时通过 Gateway API 编辑。配置 schema 与解析顺序见 [backend/AGENTS.md](backend/AGENTS.md)。

## 命令：根 vs 模块

**根 `make` 目标驱动整个栈**（在仓库根运行）：

```bash
# 安装与诊断
make setup            # 交互式安装向导（新用户推荐）
make doctor           # 检查配置与系统要求
make support-bundle   # 生成脱敏排障摘要、AI issue 草稿与可选 zip
make config           # 从 example 生成本地配置文件（已存在则中止）
make config-upgrade   # 将 config.example.yaml 的新字段合并进 config.yaml
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

## 跨切约定

以下约定适用于全仓库；模块细节由各模块文档负责。

- **文档同步策略** — 保持文档与代码同步：用户可见变更更新 `README.md`，开发/架构变更在同一变更集内更新相关 `AGENTS.md`。
- **测试驱动开发** — 功能与 bug 修复必须带测试。后端测试位于 `backend/tests/`（TDD 为强制要求，见 [backend/AGENTS.md](backend/AGENTS.md)）；前端测试位于 `frontend/tests/`。
- **提交前格式化** — 运行 `make format`（后端）/ `pnpm check`（前端）。后端 CI 强制 `ruff format --check`，push 前格式化必须干净。
