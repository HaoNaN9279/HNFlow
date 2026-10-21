# HNFlow —— 图驱动的确定性 AI 工作流编排引擎

HNFlow（**H**uman-**N**ode **Flow**）是一套**图驱动的确定性工作流编排引擎**。它以可视化 DAG 描述「AI 产出 → 人工审核 → 修改迭代」等可复现流程，把大模型从「自由对话」约束到「按图执行」的确定性轨道上；同时保留对话入口，让 AI Agent 辅助生成、调度与监控工作流。

HNFlow 构建于 [LangGraph](https://www.langchain.com/langgraph) 生态的 super agent harness 之上：底层复用成熟能力（Skills、MCP、Sandbox、Checkpointer、Interrupt、Subagent），上层叠加一层**工作流定义/编译层**，将纯 JSON 的 `WorkflowDefinition` 编译为可执行的 LangGraph `StateGraph`。断点续跑、人工挂起、嵌套子图等能力由 LangGraph 原生提供，HNFlow 不重复造执行引擎。

- **部署形态**：Web 服务 + 本地部署（Docker Compose 或裸机），数据主权保留在本机，不提供桌面端。
- **双入口**：可视化工作流画布（React Flow）+ AI 对话助手，两种方式平权、共享同一运行生命周期。
- **核心价值**：把「自由探索的 Agent」变成「流程中的确定性节点」，让 AI 能力可以嵌入需要稳定复现的业务链路。

---

## 目录

- [产品定位](#产品定位)
- [核心特性](#核心特性)
- [架构总览](#架构总览)
- [服务拓扑](#服务拓扑)
- [快速开始](#快速开始)
- [核心概念速览](#核心概念速览)
- [AI 节点会话：双端口模式](#ai-节点会话双端口模式)
- [对话侧调度工具](#对话侧调度工具)
- [使用场景示例](#使用场景示例)
- [后续方向](#后续方向)
- [安全说明](#安全说明)
- [License](#license)

---

## 产品定位

HNFlow 是「图驱动的确定性编排引擎」，与「对话驱动的 super agent harness」互补，而非替代：

| 维度 | HNFlow | 底层 harness |
| --- | --- | --- |
| 驱动方式 | 图（DAG）驱动，流程确定、可复现 | 对话驱动，路径自由 |
| 适用任务 | 流程型：发布、审核、批处理、多轮修改 | 自由型：开放研究、即兴问答 |
| 执行单位 | 工作流中的节点（原子节点 / AI 节点 / 人工节点） | lead agent 会话 |
| 确定性 | 拓扑与端口绑定先行定义，同输入同路径 | 由模型决策 |
| 人工参与 | 一等公民（HumanTask 挂起/恢复/打回重交） | ask_clarification 中断 |

两条路径并存于同一运行时：**流程型任务走工作流图，自由任务走现有对话**；goal loop / plan mode 作为「图中的一个 AI 节点」保留。

改造策略是在既有 harness 之上**叠加**工作流定义/编译层，将 harness 全部现有能力降为节点的执行底座，不推倒重来。

---

## 核心特性

### 可视化工作流画布

基于 React Flow 的画布页面（`/workspace/workflows/[id]`）提供拖拽建图、连线、参数编辑、保存校验的完整体验：

- 节点物料面板按类型分类：流程控制 / 数据操作 / 工具调用 / AI / 人工 / 子工作流；
- 节点参数直接显示在节点卡片上：选中后原位展开编辑区，节点可拖拽调整尺寸，内容随宽度重排；节点尺寸随定义保存到 `metadata.canvas.sizes`；
- 每个节点类型的参数由固定 schema 决定，不再提供任意 key/value 自定义参数；
- 端口连线实时类型校验（如 string 不能连 file），与后端校验规则保持一致；
- 保存时自动调用后端校验器，422 错误在画布上定位并高亮具体节点；
- 编辑器只负责编辑：运行 / 单步 / 停止按钮和底部运行窗口已移除，避免出现第二个执行入口；
- 工作流目录支持任意层级文件夹嵌套：可新建子文件夹、重命名、移动工作流；工作流编辑页以面包屑显示根目录到当前文件夹的层级；
- 工作流列表不再显示运行状态，运行状态统一由工作台和右侧执行监视面板呈现；
- 本次目录层级改造按产品要求清空旧工作流内容，不做旧数据迁移。

### 模型档案（AI 节点的模型中间层）

- 侧边栏新增 `/workspace/model-profiles`：列出并管理模型档案；
- 每个档案有稳定 `id`/`name`、展示名、描述、启停状态，并指向 `config.yaml -> models[]` 中的一个实际模型；
- AI 节点通过 `params.model_profile` 引用档案，不再直接引用实际模型；运行时由档案解析出实际模型；
- 档案目标缺失、停用时保存/运行会明确失败；被工作流引用的档案禁止删除，只能停用；AI 节点只通过模型档案选择模型；
- `GET /api/models` 仍只读，实际模型与凭据继续由运维在 `config.yaml` 管理。

### 工作台与全局执行监视

- **工作台**（`/workspace/workbenches/[id]`）是保存的项目执行界面：成员只引用工作流定义，支持运行、单步运行、取消、编辑和子工作流跳转；工作台自身不参与编译，也不拥有 run 生命周期；
- 从工作台启动的运行使用 `on_disconnect="continue"`，关闭页面或切换左侧导航不会取消任务；
- **右侧执行监视面板**挂载在 Workspace 布局层，切换左侧页面不会卸载；可像左侧侧边栏一样收起/展开，底部显示人工审核、人工任务和单步/断点暂停；
- `GET /api/workflow-monitor/runs` 跨工作台汇总当前运行与等待人工的运行；工作台看板仍按 `workbench_id` 隔离；
- 正在运行的 run 使用准入时的定义快照，编辑工作流不会热更新当前 run。

### AI 节点三层提示词

AI 节点提示词不是单一作者手写，而是运行时按**身份 → 能力 → 任务**三层拼装：

```
身份层：主 agent 的 SOUL（一次绑定，复用所有节点）
能力层：关联功能组的 rules / 工具描述 / allowed-tools 并集
任务层：template_prompt 运行时输入（不再有节点 instruction）
```

- 一个 AI 节点 = **一个主身份**（custom agent，`agent_name` 静态绑定）+ 若干功能组供给工具与规则（能力并集），避免人格冲突；
- 节点任务只来自 `template_prompt`，支持上游端口数据插值（`{{url_list}}`）；`continue_prompt` 有值时走会话续接；
- 输出 Schema 由独立 `data:schema` 节点提供，经 `output_schema` 输入端口接入；
- 上下文超限自动压缩：预算来自所选模型档案的 `context_window`，压缩使用内置压缩 skill，节点/用户无需配置；
- AI 节点不做子 Agent 调用、不做 token 预算限制；工具集仍受能力组 allowed-tools 约束；
- 旧定义可在 ackend/ 下用 PYTHONPATH=. python scripts/migrate_workflow_ai_contract.py --dry-run 预览迁移，--apply 写回。

### 功能组（Capability Group）

功能组是能力抽象单元，由现有 Skills 体系升级而来，把「一组按领域划分的能力」做成一等公民：

- **GUID 不变性**：安装时生成 GUID，改名/移动写入 aliases，引用永远有效，路径仅用于展示与语义理解；
- **语义版本 + 不可变版本目录**：存储布局 `<name>/v<semver>/`，已发布版本目录只读，修改 = 创建新版本，写路径全部走原子替换；
- **依赖解析**：frontmatter 声明 `dependencies: [{guid, versionRange}]`，保存时静态校验存在性、版本范围并做跨实体循环检测；
- **命名空间工具前缀**：同名工具自动加 `{group_namespace}.{tool_name}` 前缀，从机制上杜绝覆盖冲突；
- **懒加载**：节点执行时按 `guid@version` 加载，工作流实例生命周期内缓存复用；
- **依赖快照**：保存工作流时递归收集节点功能组依赖，固化为 `resolvedGroups`（`guid@version` 集合）落盘。

### 人工节点（HumanTask）

人工参与是流程中的一等公民节点，完整生命周期支持：

- 工作流执行到人工节点 → 挂起进入 `WaitingForHuman`，生成持久化待办；
- 待办包含任务描述、上游输入快照、输出规范与校验规则；
- 用户提交后自动校验（格式/必填/命名），通过则流程继续；失败则任务回 `reopened` **打回重交**；
- 支持跳过（`{"__skip": True}`）与打回；AI 节点内部的 `interrupt()` 也统一转化为 HumanTask 待办，外层封装无需感知内部类型。

### 断点续跑

LangGraph checkpointer（sqlite / postgres）覆盖整图（含子图）：

- 每步执行状态持久化，进程崩溃后重启可从断点恢复，画布显示「从 XX 节点续跑」；
- 一个工作流实例 = 一个 thread_id，子图/并行分支用不同命名空间隔离状态；
- 挂起（人工待办）状态同样持久化，重启后仍在待办列表。

### 嵌套子工作流

- **编译期子图**：definition 引用另一 definition，编译时内联展开为嵌套 StateGraph，自动获得子图 checkpointer 与错误传播；
- **运行期委派**：子工作流节点可选委派模式，由增强版 task_tool 委托子 agent 执行；
- 子图与父图 state 分离，仅通过端口映射通信（写时复制边界保证大值嵌套共享）；
- 编译前做嵌套深度限制（默认 ≤10 层）与全局依赖图循环检测，报完整引用链。

### 白捡能力

执行引擎、断点、挂起、MCP、沙箱、记忆、子代理、扩展系统全部复用底层 harness：

- **MCP**：stdio / http / sse、OAuth、session pool、tool_search 懒加载、路由提示；
- **Sandbox**：本地 / Docker 两种模式，bash 等命令类节点强制走沙箱执行，禁止直连宿主 shell；
- **Skills / 扩展**：middleware 链、allowed-tools 策略、skill 安全扫描原样作用于节点执行上下文；
- **调度**：scheduler（cron / once）与多租户 user_id 隔离直接套用。

---

## 架构总览

HNFlow 采用六层架构，核心是**定义层 + 编译层**新增，其余全部复用既有 harness：

```
┌─────────────────────────────────────────────────────────────┐
│ 用户交互层（Next.js）                                          │
│   ├── 对话界面（chat UI + SSE）                    ← 复用      │
│   └── 工作流画布（React Flow，/workspace/workflows） ← 接线    │
├─────────────────────────────────────────────────────────────┤
│ 工作流定义层（backend/packages/harness/deerflow/workflow/）     │
│   ├── schema.py      节点/边/端口类型定义（Pydantic v2）        │
│   ├── workflow_io.py WorkflowDefinition JSON 序列化/校验        │
│   └── registry.py    节点执行器注册表（原子/AI/人工/数据/流程）  │
├─────────────────────────────────────────────────────────────┤
│ 编译层                                                       │
│   └── compiler.py    WorkflowDefinition → LangGraph StateGraph│
│       节点→图节点；边→普通边/条件边；端口→state 字段            │
├─────────────────────────────────────────────────────────────┤
│ 执行引擎层（复用 runtime/，薄封装）                             │
│   ├── worker.py          编排 run / checkpointer / SSE 事件    │
│   ├── executors/         ai / data / flow / human / tool       │
│   ├── prompts.py         三层提示词组装（身份→能力→任务）        │
│   └── workflow_io        运行期 HumanTask 挂起/恢复（Command）  │
├─────────────────────────────────────────────────────────────┤
│ 能力层（全部复用）                                            │
│   ├── capability_groups/  Skills 版本化 + GUID + 依赖          │
│   ├── mcp / sandbox / subagents / extensions                  │
│   └── custom agents      agent_name → SOUL + 工具集            │
├─────────────────────────────────────────────────────────────┤
│ 基础设施层（复用）                                            │
│   ├── persistence/      workflow_definitions / human_tasks 表  │
│   ├── runtime events     JSONL / DB 事件流（SSE 驱动）          │
│   └── user-scoped storage（定义按 user 隔离）                  │
└─────────────────────────────────────────────────────────────┘
```

**核心理念**：`WorkflowDefinition` 是纯 JSON（可序列化、可校验、可版本化），编译后变成 LangGraph `StateGraph`（可执行）。可序列化由定义层保证，可执行 / 断点 / 挂起 / 恢复全部继承 LangGraph 语义。

- **定义层与执行层解耦**：数据模型不引入 LangGraph 依赖，保证纯 JSON 可序列化；
- **不造新调度器**：流程控制全部转为 LangGraph 语义（条件边 = Route 函数），出错行为沿用默认；
- **校验器是纯函数**：图结构无环（DFS）、单起点单终点、端口类型匹配、参数合法，供后端保存与前端画布实时校验共用同一套规则。

---

## 服务拓扑

默认 `make dev` / Docker 栈运行四个协作服务：

| 服务 | 端口 | 角色 |
| --- | --- | --- |
| **Nginx** | `2026` | 统一反向代理入口，浏览器访问入口 |
| **Gateway API** | `8001` | FastAPI REST API + 内嵌 LangGraph 兼容 agent 运行时 |
| **Frontend** | `3000` | Next.js Web 界面 |

- Nginx 是唯一对外入口：托管前端，并将 `/api/langgraph/*` 重写为 Gateway 原生 `/api/*` 路由，其余 `/api/*` 直连 Gateway REST 路由；
- 两个 compose 文件均以 `${BIND_HOST:-127.0.0.1}:${PORT:-2026}:2026` 发布入口——**默认绑定 loopback**，匹配本地部署模型；裸写 `"${PORT}:2026"` 会绑定 `0.0.0.0`，需显式确认；
- Gateway 的 `8001` 在容器内有意不对外发布，全部外部流量只经过 nginx。

---

## 快速开始

### 环境要求

- Python 3.12+（uv 管理虚拟环境）
- Node.js 22+（pnpm / bun 均可，前端使用 pnpm）
- 可选：Docker（沙箱隔离与 Docker Compose 部署）

### 配置

从仓库根目录复制模板生成本地配置：

```bash
cp config.example.yaml config.yaml               # 主配置：模型、沙箱、数据库、通道
cp extensions_config.example.json extensions_config.json  # 扩展：MCP servers + skills
```

或直接运行交互式配置向导（推荐，约 2 分钟）：

```bash
make setup
```

向导会引导选择 LLM provider、可选 Web 搜索、执行/安全偏好（沙箱模式、bash 访问、文件写入工具），生成最小 `config.yaml` 并把密钥写入 `.env`。`make doctor` 可随时校验配置并给出修复提示。

运行时状态默认落在项目根 `.deer-flow/`（可用 `DEER_FLOW_HOME` 调整），skills 默认在 `skills/`（可用 `DEER_FLOW_SKILLS_PATH` 调整）。

### 本地开发模式

```bash
make check      # 校验工具链（Node.js 22+、pnpm、uv、nginx）
make install    # 安装后端 + 前端依赖 + pre-commit hooks
make dev        # 启动全部服务（Gateway + Frontend + Nginx，热重载）
```

浏览器打开 <http://localhost:2026>。

### Docker 部署

```bash
make up         # 构建镜像并启动全部生产服务
make down       # 停止并移除容器
```

浏览器打开 <http://localhost:2026>。

长期部署建议配置 `database.backend` 为 `sqlite` 或 `postgres`（LangGraph checkpointer、Store 与应用数据共享同一后端）。HNFlow 单机单 worker（`GATEWAY_WORKERS=1`），SSE 由进程内内存 stream bridge 承担，无需 Redis。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `make setup` / `make doctor` | 交互式配置 / 配置体检 |
| `make dev` / `make stop` | 本地开发启动（热重载）/ 停止 |
| `make start` / `make start-daemon` | 本地生产模式（前台 / 守护进程） |
| `make up` / `make down` | Docker 生产栈启动 / 停止 |
| `make docker-start` / `make docker-logs` | Docker 开发环境启动 / 日志 |
| `make support-bundle` | 生成脱敏诊断包 |

---

## 核心概念速览

| 概念 | 说明 |
| --- | --- |
| **工作流（Workflow）** | 节点与连线组成的有向无环图，可独立执行、可嵌套调用；定义即 `WorkflowDefinition` 纯 JSON |
| **节点（Node）** | 最小执行单元，含输入/输出端口、参数、能力组声明；类型分 `flow`（start/end/if/switch/loop/parallel/wait）、`data`（assign/convert/file/json/regEx/shared）、`tool`（bash/http/notify/log）、`ai`（llm_agent）、`human`（human_task）、`nested`（subworkflow） |
| **端口（Port）** | 数据输入/输出接口，类型用枚举（data/file/bool/enum），连线时做类型校验；节点间仅通过端口传递数据 |
| **功能组（Capability Group）** | 按领域划分的能力声明集合（GUID + 语义版本 + 不可变版本目录），AI 节点的能力供给来源 |
| **人工任务（HumanTask）** | 挂起工作流等待人工处理的节点，支持提交/跳过/打回重交，状态机 `pending → submitted / skipped / reopened / expired` |
| **AI 节点会话** | AI 节点级会话上下文，`template_prompt` 提供本轮模板输入、`continue_prompt` 走 continue 模式（见下节） |
| **子工作流（Subworkflow）** | 引用另一 definition 的节点，支持编译期子图与运行期委派两种模式，端口映射通信 |
| **checkpoint** | LangGraph 断点持久化，一个工作流实例 = 一个 thread_id，支撑断点续跑与挂起恢复 |

### AI 节点会话：template / continue

AI 节点通过两个输入端口控制执行模式：

| 端口 | 有值行为 |
| --- | --- |
| `template_prompt` | **template 模式（默认）**：作为本轮唯一任务输入，支持 `{{port}}` 插值；节点不读取历史消息 |
| `continue_prompt` | **continue 模式**：把新提示词追加到该节点既有会话消息历史，续接节点 checkpoint，适合迭代式任务 |

- 优先级固定：`continue_prompt` 有值 → continue；否则 → template。两端口同时有值时 continue 优先，`template_prompt` 忽略并记录 warning；
- 会话 key 稳定：`checkpoint_thread_id = {origin_thread_id}:wfai:{node_id}`，跨 run 经 context 注入 `ai_origin_thread_id` 定位旧会话；
- template 分支不创建会话 checkpoint；`template_prompt` 缺失时节点执行前直接失败；
- continue 不违反「AI 节点 ≠ 自由 ReAct」约束：仍限关联功能组工具，只是多轮受限对话；loop 迭代次数即硬上限；
- 触发入口：画布运行面板「继续会话」表单、对话侧 `continue_node(run_id, node_id, prompt)` 工具、REST `POST /workflows/{definition_id}/runs/{run_id}/continue`；
- 缓存观测：节点 `token_usage`（含稀疏 `cache_read_tokens`）经保留通道由 worker 聚合进 `run.end.content["token_usage"]`，无用量节点保持 absent，绝不补零。

### AI 节点能力内容

AI 节点会读取当前激活能力组（含 `extends` 闭包）的运行时内容：

- `rules/**/*.md`：全部正文注入 `capability_rules` 系统 bucket；
- `skills/**/SKILL.md`：system prompt 只放 `name + description`，完整正文由只读工具 `read_capability_skill` 按需读取；
- 能力组工具仍由 `allowed-tools` 并集装配；规则与 skill 名称会出现在 Prompt 来源列表，便于逐项审计。

工作流 `params.user_prompt` 已移除；旧定义中的该参数在运行时忽略，并在下次保存时清理。

---

## 对话侧调度工具

lead agent 内置工作流工具，让 AI 对话与画布操作走**同一套 API**（双入口一致性，无旁路）：

| 工具 | 作用 |
| --- | --- |
| `generate_workflow(prompt)` | 自然语言 → WorkflowDefinition JSON，过校验器（失败自动修正重试 ≤2 次）后保存；危险节点默认带「待审核」标记 |
| `edit_workflow(definition_id, instruction)` | 读现有定义 + 指令完整重生成，更新同一 definition_id |
| `run_workflow(definition_id, params, wait)` | 启动运行；`wait=True` 轮询至终态并聚合节点进度（completed/total + current/failed），`wait=False` 立即返回后台执行 |
| `get_workflow_run(run_id)` | 反复查询运行进度（含可选 `token_usage`） |
| `continue_node(run_id, node_id, prompt)` | 对 AI 节点会话追加提示词继续执行 |
| `list_human_tasks(status)` / `submit_human_task(task_id, values)` / `skip_human_task(task_id)` | 查询待办、提交（校验 output_spec + validation_rules 后触发 resume）、跳过 |
| `pause_workflow` / `resume_workflow` / `cancel_workflow` | 运行控制（包装 run API） |

约束：生成结果必须通过图结构校验才可保存——「Agent 只能调用已注册能力」是强制边界。

---

## 使用场景示例

**AI 产出 → 人工审核 → 打回重改**（AI 节点 continue 会话 + loop 迭代 + 人工节点的典型组合）：

> 注意：当前 template 分支不会创建 session checkpoint。以下图式的 `template → continue` 自动续接需要后续会话修复；当前 continue 适合在已建立的 continue 会话之间续接。

```
start → 任务描述 → AI 节点（template_prompt，初轮 reset）
                      ↓
                   draft 端口
                      ↓
                human_task 审核 → feedback 端口
                      ↓
                 if 通过?
                    ├─ 通过 → notify → end
                    └─ 不通过 → loop（迭代计数 + 深度上限）
                          loop.item（本轮 feedback）→ AI 节点（continue_prompt）
                          → AI 节点（continue 同一会话）→ human_task → if ...（自环）
```

执行语义：

1. **初轮**：AI 节点用 `template_prompt` 模板全量执行，产出草稿写入 `draft` 端口；
2. **人工审核**：`human_task` 挂起工作流，生成待办；用户提交审核意见（或打回理由）后恢复；
3. **迭代**：未通过时 loop 节点把本轮 feedback 经 `continue_prompt` 喂回同一 AI 节点会话——AI 在**既有上下文**上按建议修改，而不是从零重跑；
4. **收敛**：loop 迭代计数即硬上限，防止无限打回；`draft` 端口每轮覆盖，下游永远审最新稿；
5. **结束**：通过后走 notify 通知结束。

同样的图式可推广到「内容审校」「代码评审」「文档多轮润色」等所有需要人机多轮迭代的流程。

---

## 后续方向

以下能力按「先量后做」原则规划，尚未立项：

- **缓存感知执行规划器**：观测已落地（cache token 指标进 run 终态），但执行顺序规划器待 benchmark 验证收益后再立项。候选形态：编译期拓扑层内按功能组聚类贪心排序 + 运行时局部贪心 + 断点续跑重新规划。
- **Loop 正宗版**：子图展开 + 条件边 + `results`/`last` 聚合输出（当前为简单版：`iteration` 轮次计数 + `out` 透传）。
- **复杂任务分诊**：节点内不放开自由路由，后续由画布条件边显式路由承载。

---

## 安全说明

HNFlow 默认面向**本地信任环境模型**（个人 / 小团队本机部署），但仍遵循最小暴露与隔离原则：

- **默认 loopback 绑定**：compose 入口默认 `127.0.0.1:2026`，不暴露公网；需要对外服务时显式设置 `BIND_HOST` 并自行评估风险；
- **沙箱隔离**：bash / command 等命令类节点强制走 Sandbox 执行（本地 / Docker 模式），禁止直连宿主 shell；文件写入同样受沙箱文件系统约束；
- **危险节点默认待审核**：AI 生成的 bash / http 等危险节点默认写入 `pending_review_nodes` 元数据，运行时要求人工确认；生成工具的任何结果必须过图结构校验才可保存；
- **人工确认兜底**：节点失败直接终止，由人工确认后处理；涉及覆盖、提交、删除、发布等操作必须用户二次确认；
- **依赖静态校验**：功能组依赖存在性、版本范围、循环引用在保存时静态拦截，节点锁定 `guid@version`，新版本只提示不自动升级；
- **用户隔离**：user_id 作用域存储，多用户同名工作流互不可见；
- **部署提醒**：若部署到共享环境或多 worker 生产模式，请按上节「服务拓扑 / 快速开始」的说明配置持久化数据库、Redis stream bridge 与所有权心跳，并参考 `make doctor` 输出。

---

## License

[MIT](./LICENSE)
