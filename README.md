# HNFlow —— 图驱动的确定性 AI 工作流编排引擎

HNFlow（**H**uman-**N**ode **Flow**）把 AI 产出、人工审核、修改迭代等流程固化为一套**可复现的有向无环图**。它以 DeerFlow harness（LangGraph super agent 底座）为内核，在其上叠加工作流定义/编译层，把 Skills、MCP、Sandbox、Checkpointer、Interrupt、Subagent 等能力降为节点的执行底座。

- **双入口**：React Flow 工作流画布 + AI 对话（Lead Agent），两者共享同一套 API 与运行生命周期。
- **本地部署**：Docker Compose 或裸机，数据保留在本机 `hnflow-data/`。
- **定义与执行解耦**：`WorkflowDefinition` 是纯 JSON，经 `compiler` 编译为 LangGraph `StateGraph`。

---

## 产品定位

| 维度 | HNFlow | 对话式 harness |
| --- | --- | --- |
| 驱动方式 | 图（DAG）驱动，流程确定、可复现 | 对话驱动，路径自由 |
| 适用任务 | 发布、审核、批处理、多轮修改 | 开放研究、即兴问答 |
| 执行单位 | 工作流节点 | Lead Agent 会话 |
| 人工参与 | 一等公民（挂起/恢复/打回重交） | `ask_clarification` 中断 |

流程型任务走工作流图，自由任务走对话；goal loop / plan mode 作为图中的 AI 节点保留。

---

## 核心能力

### 工作流画布

- 路由 `/workspace/workflows`：任意层级文件夹、拖拽建图、连线、参数编辑、保存校验。
- 节点参数由固定 schema 决定，不再支持任意 key/value 参数；端口连线实时类型校验。
- 保存时调用后端校验器，422 错误在画布上定位到具体节点。
- 编辑器只负责编辑：运行/单步/停止全部由工作台发起，避免第二个执行入口。
- 节点尺寸与自定义标签保存在 `metadata.canvas.*`，不进入定义本体。

### 项目与工作台

- 项目是文件化工作台：`<project>/.hnflow/project.json` 与 `.hnflow/workbenches/*.workbench.json` 是唯一数据源。
- 工作台是保存的项目执行界面：成员只引用工作流定义，支持运行、单步、取消和编辑跳转；自身不参与编译，也不拥有 run 生命周期。
- 从工作台启动的运行使用 `on_disconnect="continue"`，关闭页面不会取消任务。
- 右侧全局执行监视面板挂载在 Workspace 布局层，切换页面不卸载；汇总运行中与等待人工的 run，并处理人工审核/任务/单步暂停。

### 模型档案

- `/workspace/model-profiles` 管理 AI 节点与实际模型之间的中间层。
- AI 节点通过 `params.model_profile` 引用档案；档案指向 `config.yaml -> models[]` 中的实际模型。
- 档案缺失、停用或被引用时删除会 fail-loud；`GET /api/models` 仍只读。

### AI 节点三层提示词

```
身份层：agent_name 绑定的主身份（SOUL）
能力层：能力组的 rules / skills / allowed-tools 并集
任务层：template_prompt（continue_prompt 走会话续接）
```

- 一个 AI 节点 = 一个主身份 + 若干能力组，避免人格冲突。
- 输入/输出 Schema 来自同一个 `data:schema` 节点的 `input_schema` / `output_schema` 端口；AI→AI 交付两侧必须绑定同一 Schema 节点。
- 输出统一为 **AI Result Envelope**：固定字段 `summary/status/content/artifacts/metadata/error` + `custom`。
- 上下文超限自动压缩：预算来自模型档案的 `context_window`，使用内置压缩 skill，无节点参数。
- AI 节点不做子 Agent 调用、无 token 预算、无节点级记忆或知识检索。

### 能力组与工具

- 能力组和工具包位于外部 VibeStack 仓库，HNFlow 只读取解析，不播种不写入：
  - 能力组：`<repo>/capability-groups/<name>/<version>/group.json`
  - 工具包：`<repo>/tools/<name>/<version>/tool.json`
- 项目激活写入 `<project>/.vibestack/stack.json`；Core 固定加载，保存工作流时只增量写入所需组。
- 统一工具 ID：`tool:<guid>@v<version>`、`mcp:<server>:<tool>`、`builtin:<name>`、`sandbox:<name>`、`app:<name>`。
- `/workspace/capability-groups` 为只读目录面板，不提供编辑/删除。

### 人工节点与断点

- `human:task`：挂起生成持久化待办，提交后校验并恢复；支持跳过与打回重交。
- `human:review`：审批/拒绝；拒绝经 `continue_prompt` 回跳到上游 AI 节点继续会话。
- 单步调试是 run 级开关 `debug_step`，每个节点前生成 `kind="step"` 待办。
- LangGraph checkpointer（sqlite/postgres）覆盖整图与子图：一个工作流实例 = 一个 `thread_id`，崩溃后可断点续跑。

### 嵌套与容错

- 编译期子工作流内联为嵌套 `StateGraph`；运行期可委派子 agent。
- `flow:try` 容错容器、`flow:handoff` 受控动态路由、`verify:gate` 三值验证门禁。
- 失败回滚与撤销：`data:file`、`data:asset`、`app:script` 默认备份/回滚；运行级 undo 记录可按最新优先恢复。

---

## 架构总览

```
┌──────────────────────────────────────────────────────────┐
│ 用户交互层（Next.js）                                     │
│  对话（Lead Agent） + 工作流画布 + 工作台 + 执行监视       │
├──────────────────────────────────────────────────────────┤
│ 定义层（deerflow/workflow/）                              │
│  schema.py / workflow_io.py / spec.py / verification.py   │
├──────────────────────────────────────────────────────────┤
│ 编译层（compiler.py）                                     │
│  WorkflowDefinition → LangGraph StateGraph                │
│  节点→图节点，边→普通/条件边，端口→wf:<node>:<port>       │
├──────────────────────────────────────────────────────────┤
│ 执行层（worker.py / executors/ / prompts.py）             │
│  run / checkpointer / SSE / 人工挂起 / 回滚 / 撤销         │
├──────────────────────────────────────────────────────────┤
│ 能力层（复用 harness）                                    │
│  capability_groups / mcp / sandbox / subagents / apps     │
├──────────────────────────────────────────────────────────┤
│ 基础设施层                                               │
│  SQLite/Postgres / 事件流 / 用户隔离 / VibeStack 解析      │
└──────────────────────────────────────────────────────────┘
```

约束：

- 定义层不引入 LangGraph 依赖，保证纯 JSON 可序列化。
- 流程控制全部转为 LangGraph 语义（条件边 = Route 函数），不另造调度器。
- 校验器是纯函数，后端保存与前端画布共用同一套规则。

---

## 服务拓扑

| 服务 | 端口 | 角色 |
| --- | --- | --- |
| Nginx | `2026` | 唯一公共入口，托管前端并代理 API |
| Gateway API | `8001` | FastAPI REST + LangGraph 兼容运行时 |
| Frontend | `3000` | Next.js 界面 |

- Nginx 将 `/api/langgraph/*` 重写为 Gateway 原生 `/api/*`，其余 `/api/*` 直通 Gateway。
- 两份 compose 默认 `"${BIND_HOST:-127.0.0.1}:${PORT:-2026}:2026"`，默认仅回环绑定。
- Gateway 的 `8001` 在容器内不对外发布。

---

## 快速开始

### 环境要求

- Python 3.12+、uv
- Node.js 22+、pnpm 10+
- 可选：Docker（沙箱隔离与 Compose 部署）

### 初始化配置

所有用户数据统一放在仓库根 `hnflow-data/`（整体 gitignored）：

```text
hnflow-data/
├── config.yaml / extensions_config.json / .env / frontend.env
├── prompts/lead-agent.md
├── skills/
├── data/deerflow.db
└── users/{user_id}/threads/{thread_id}/...
```

```bash
make config        # 从 config-examples/ 播种，已存在则中止
make setup         # 或运行交互式向导（推荐）
make data-migrate  # 旧布局迁移，DRY=1 预览，只复制不删除
```

能力组与工具包不随仓库分发，HNFlow 直接读取配置的 VibeStack checkout：

```yaml
vibestack:
  repository: D:/workspace/work/VibeStack
  core: core@0.1.0   # 可选
```

Docker 模式需把 VibeStack 仓库额外挂载进容器，并让 `vibestack.repository` 指向容器内路径。

规范根变量为 `HNFLOW_HOME`，`DEER_FLOW_HOME` 继续兼容；SQLite 相对目录按统一根解析。`make doctor` 可校验配置。

### 本地开发

```bash
make check      # 校验工具链
make install    # 安装后端 + 前端依赖 + pre-commit
make dev        # Gateway + Frontend + Nginx（热重载）
```

浏览器打开 <http://localhost:2026>。

### Docker

```bash
make docker-start   # 开发栈
make up             # 生产栈
make down           # 停止生产栈
```

长期部署建议 `database.backend` 使用 `sqlite` 或 `postgres`；单机单 worker（`GATEWAY_WORKERS=1`），SSE 由进程内 stream bridge 承担。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `make setup` / `make doctor` | 配置向导 / 配置体检 |
| `make dev` / `make stop` | 本地开发启动 / 停止 |
| `make start` / `make start-daemon` | 本地生产模式 |
| `make up` / `make down` | Docker 生产栈 |
| `make docker-start` / `make docker-logs` | Docker 开发栈 |
| `make support-bundle` | 脱敏诊断包 |

---

## 核心概念

| 概念 | 说明 |
| --- | --- |
| 工作流 | 节点与连线组成的有向无环图，可独立执行、可嵌套 |
| 节点 | 含输入/输出端口、参数、能力组声明；类型见下 |
| 端口 | `data/file/bool/enum/number/array/record/spec`，连线做类型校验 |
| 能力组 | GUID + 语义版本 + 不可变版本目录，AI 节点能力来源 |
| 人工任务 | `pending → submitted / skipped / reopened / expired` |
| 子工作流 | 编译期子图或运行期委派，仅通过端口映射通信 |
| checkpoint | 一个工作流实例 = 一个 `thread_id` |

节点类型：

- `flow`：start / end / if / switch / loop / parallel / wait / try / handoff
- `data`：assign / convert / file / json / regEx / shared / schema / spec / asset
- `tool`：bash / http / notify / log / invoke
- `ai`：llm_agent
- `app`：launch / script / wait / collect
- `human`：task / review
- `nested`：subworkflow
- `verify`：gate

### AI 节点 template / continue

| 端口 | 行为 |
| --- | --- |
| `template_prompt` | 默认模式：本轮唯一任务输入，支持 `{{port}}` 插值，不读取历史 |
| `continue_prompt` | 续接模式：追加到节点既有会话，跨 run 使用 `{origin_thread_id}:wfai:{node_id}` |

优先级：`continue_prompt` 有值走 continue，否则 template。两者同时有值时 continue 优先并记录 warning。触发入口：画布继续会话、`continue_node` 工具、`POST /workflows/{id}/runs/{run_id}/continue`。

### 对话侧调度工具

Lead Agent 内置与画布同源的 API 工具：

`generate_workflow` / `edit_workflow` / `run_workflow` / `get_workflow_run` / `continue_node` / `list_human_tasks` / `submit_human_task` / `skip_human_task` / `pause_workflow` / `resume_workflow` / `cancel_workflow` / `undo_workflow_run`。

生成结果必须通过图结构校验才可保存。

---

## 安全

- 默认 loopback 绑定，对外服务需显式设置 `BIND_HOST`。
- `tool:bash` 等命令类节点强制走 Sandbox，禁止直连宿主 shell；`app:*` 是宿主执行的显式例外。
- AI 生成的 bash/http 等危险节点默认标记待审核。
- 非幂等工具节点（`tool:invoke`、`app:launch/script`）受 crash-confirm 门约束。
- 能力组快照记录 `guid@version` 与内容 hash，外部仓库更新不会悄悄改变运行行为。
- user_id 作用域存储，多用户同名工作流互不可见。

---

## License

[MIT](./LICENSE)
