# AGENTS.md

本文件是 HNFlow monorepo 的导览层，只负责映射结构、命令与跨切约定。模块细节以模块文档为准：

- **[backend/AGENTS.md](backend/AGENTS.md)** —— harness/app 分层、agent 与中间件链、runtime/SSE、sandbox、MCP、skills、memory、workflow、持久化/迁移、配置、测试。
- **[frontend/AGENTS.md](frontend/AGENTS.md)** —— Next.js App Router、thread/流式数据流、工作流编辑器、工作台、执行监视、代码风格。

## HNFlow 是什么

HNFlow 是**图驱动的确定性编排引擎**。它以 DeerFlow harness（LangGraph super agent 底座）为内核，叠加工作流定义/编译层，把 Skills、MCP、Sandbox、Checkpointer、Interrupt、Subagent 降为节点的执行底座。

- **双入口**：React Flow 画布 + AI 对话，控制同一运行生命周期。
- **执行模型**：流程型任务走工作流图（节点执行、端口数据流、断点续跑、人工挂起），自由任务走对话；goal loop / plan mode 作为图中的一个 AI 节点。
- **核心理念**：`WorkflowDefinition` 是纯 JSON，经 `compiler` 编译为 LangGraph `StateGraph`；可序列化由定义层保证，可执行/断点/挂起复用 LangGraph 原生语义。

### 工作流执行模型

节点按类型分七类：

- `flow`：start / end / if / switch / loop / parallel / wait / try / handoff
- `data`：assign / convert / file / json / regEx / shared / schema / spec / asset
- `tool`：bash / http / notify / log / invoke
- `ai`：llm_agent
- `app`：launch / script / wait / collect
- `human`：task / review
- `nested`：subworkflow
- `verify`：gate

端口数据经 state 字段流转（`wf:<node_id>:<port>`），由 compiler 绑定；节点执行函数与 state 解耦。断点续跑、人工挂起、取消、SSE 节点级事件全部复用 LangGraph/DeerFlow 既有 run 生命周期。

关键约束：

- `tool:bash` 必须走 sandbox，禁止直连宿主 shell；`app:*` 是宿主执行的显式例外。
- 同一输入端口只允许一条入边，`flow:end` 与 `flow:loop` 除外。
- `verify:gate` 的 `verified` / `failed` / `inconclusive` 三分支必须全部接线。
- AI 节点只通过 `params.model_profile` 选模型；输入/输出 Schema 来自同一个 `data:schema` 节点。
- 非幂等工具节点受 crash-confirm 门约束。

## 服务拓扑

| 服务 | 端口 | 角色 |
| --- | --- | --- |
| Nginx | `2026` | 唯一公共入口 |
| Gateway API | `8001` | FastAPI REST + 内嵌 LangGraph 兼容运行时 |
| Frontend | `3000` | Next.js 界面 |

Nginx 托管前端，并把 `/api/langgraph/*` 代理到 Gateway 的 LangGraph 运行时（重写为原生 `/api/*`）；其余 `/api/*` 直通 Gateway。

两份 compose 文件把入口发布为 `"${BIND_HOST:-127.0.0.1}:${PORT:-2026}:2026"`，**默认回环绑定**。Gateway 的 `8001` 在容器内故意不发布；`backend/tests/test_compose_default_bind_host.py` 钉死该约束。

## 仓库地图

```
HNFlow/
├── Makefile                  # 根编排：dev/start/stop、docker、setup
├── config-examples/          # 配置模板（config/prompts/workflows/model-profiles）
├── config.example.yaml       # 主配置模板
├── extensions_config.example.json
├── hnflow-data/              # 唯一用户数据根（gitignored）
├── backend/                  # Python 后端，见 backend/AGENTS.md
│   ├── packages/extension-api/   # 公共扩展契约（deerflow_extension_api.*）
│   ├── packages/harness/         # agent 框架（deerflow.*）
│   └── app/                      # FastAPI Gateway（app.*）
├── frontend/                 # Next.js 前端，见 frontend/AGENTS.md
├── docker/                   # compose、nginx
├── skills/                   # 内置 skills 模板
├── contracts/                # 跨组件 JSON 契约
└── scripts/                  # 根编排脚本
```

### 工作流子系统（`backend/packages/harness/deerflow/workflow/`）

- `schema.py` —— 节点/边/端口/节点类型定义（Pydantic v2），定义层不依赖 LangGraph。
- `workflow_io.py` —— `validate_definition`：无环 DFS、单起点单终点、端口类型匹配、单入边、Schema/verify 边校验；`serialize`/`deserialize` 带版本迁移。
- `spec.py` / `verification.py` —— 不可变规约修订（draft/frozen/superseded）、三值验证与结构化诊断；`spec` 端口只传 `SpecRef`。
- `verifiers/` —— `spec_lint`、`mock_verifier`、`dafny_verify`、`tla_model_check`、`lean_check`、`cel_evaluate`，CLI 经 sandbox 执行。
- `compiler.py` —— 定义 → LangGraph；端口绑定、节点生命周期事件、loop/try/handoff 展开、共享工作区、资源锁、编译缓存、verify 路由。
- `worker.py` / `runtime_context.py` —— 编排入口与唯一 compile/runtime context 装配点，复用 RunRecord/checkpointer/run events。
- `model_profiles/` —— AI 节点模型中间层，profile 只指向 `config.yaml -> models[]`。
- `context_compression.py` —— 按模型 `context_window` 自动压缩，复用 summarization middleware。
- `executors/` —— `flow/data/asset/tool/local_app/human/review/ai/spec/verify`；`data:file`、`data:asset`、`app:script` 默认失败回滚。
- `prompts.py` / `prompt_preview.py` —— identity / capability / capability_rules / capability_skills / specification / schema_contract / task / schema 提示词桶。
- `structured_output.py` —— AI Result Schema 解析/校验/修复、Envelope、`[schema.*]` 引用。
- `patterns.py` / `handoff.py` / `evals.py` / `replay.py` / `budgets.py` / `costs.py` / `reliability.py` / `breakpoint.py` / `delegate.py` / `dispatch.py` / `human_task_state.py` —— 模板、动态 handoff、评测、回放、预算、成本、幂等、断点、委派。
- `compensation.py` / `undo.py` / `undo_service.py` —— 失败回滚与撤销。
- `../projects/` —— 文件化项目/工作台；`<project>/.hnflow/project.json` 与 `.hnflow/workbenches/*.workbench.json` 是数据源。
- `../apps/` —— 本地应用接入层；`../assets/`、`../environment/`、`../portability/` 为资产、环境探测、备份迁移。

### 扩展与配置

第三方扩展从 `config.yaml` 顶层 `plugins:` 加载。该列表会导致代码导入，因此刻意不放入 API 可写的 `extensions_config.json`。

### 统一数据目录（`hnflow-data/`）

```text
hnflow-data/
├── config.yaml / extensions_config.json / .env / frontend.env
├── prompts/lead-agent.md
├── skills/
├── data/deerflow.db
└── users/{user_id}/threads/{thread_id}/...
```

- 规范根变量 `HNFLOW_HOME`；`DEER_FLOW_HOME` 作为兼容别名。
- 配置解析顺序：显式 `DEER_FLOW_CONFIG_PATH` → `$HNFLOW_HOME/config.yaml` → 旧位置。
- SQLite 相对 `sqlite_dir` 按统一根解析，默认 `data`。
- 工作流定义/规约/模型档案/运行/待办/撤销记录在 `data/deerflow.db`；实例文件在 `users/`。
- 能力组与工具包由外部 VibeStack 仓库提供：`vibestack.repository` → `VIBESTACK_HOME` / `VIBESTACK_REPO` → `~/.config/vibestack/config.json`。HNFlow 不播种、不写入。
- `make config` 只复制缺失模板；`make data-migrate`（`DRY=1` 预览）只复制不删除。

## 命令：根 vs 模块

```bash
# 根目录：整个应用
make setup / doctor / config / config-upgrade / data-migrate
make check / install / setup-sandbox
make dev / dev-daemon / start / start-daemon / stop
make docker-init / docker-start / docker-stop / docker-logs
make up / down
make support-bundle
make detect-thread-boundaries / detect-blocking-io

# 后端（backend/）
make install / dev / gateway / test / lint / format
make migrate-rev MSG="..."

# 前端（frontend/）
pnpm dev / build / check / test / test:e2e / typecheck
```

根 `make` 驱动整个栈；模块命令只作用于对应模块。宿主侧 pnpm 统一经 `scripts/pnpm.py`。

## 跨切约定

- **文档同步**：用户可见变更更新 `README.md`，开发/架构变更同步更新相关 `AGENTS.md`。
- **测试驱动**：功能与 bug 修复必须带测试；后端在 `backend/tests/`，前端在 `frontend/tests/`。
- **提交前格式化**：后端 `make format`（CI 强制 `ruff format --check`），前端 `pnpm check`。
- **删除不用的 DeerFlow 遗留文档/脚本**，不要让旧计划、旧入口重新进入文档导航。

## 下一步

- 后端 → [backend/AGENTS.md](backend/AGENTS.md)
- 前端 → [frontend/AGENTS.md](frontend/AGENTS.md)
- 安装 → [Install.md](Install.md)
- 使用与发布 → [README.md](README.md) / [RELEASING.md](RELEASING.md)
