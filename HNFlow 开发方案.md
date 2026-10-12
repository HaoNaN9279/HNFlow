# HNFlow 开发方案

> 本文件是 HNFlow 当前阶段的权威开发方案：描述系统现状、架构分层、核心机制与后续规划。Web 服务 + 本地部署形态，后端 Python（FastAPI + LangGraph），前端 Next.js + React Flow。

## 一、整体定位与设计目标

### 1.1 核心定位

HNFlow（**H**uman-**N**ode **Flow**）是一套**图驱动的确定性工作流编排引擎**，面向软件开发者和 AI 工作流构建者，充当「流程管家」。

它以可视化 DAG 描述「AI 产出 → 人工审核 → 修改迭代」等可复现流程，把大模型从「自由对话」约束到「按图执行」的确定性轨道；同时保留对话入口，让 AI Agent 辅助生成、调度与监控工作流。确定性与自主性并存：**流程型任务走工作流图，自由任务走对话**。

### 1.2 部署形态

- Web 服务 + 本地部署（Docker Compose 或裸机），数据主权保留在本机，**不提供桌面端**。
- 默认回环绑定（`127.0.0.1:2026`），需要对外服务时显式设置 `BIND_HOST`。
- **双入口平权**：可视化画布（React Flow）与 AI 对话助手，控制同一运行生命周期，行为一致。

### 1.3 核心设计目标

1. **领域无关**：核心引擎不依赖任何游戏引擎或专业软件，领域特定能力通过功能组/技能插件化接入。
2. **人机协同**：人工操作是一等公民节点，支持审核、修改、跳过、打回重交等完整生命周期。
3. **两级扩展**：内置原子节点库 + 自定义能力（功能组 + 子工作流）。
4. **AI 辅助 + 可视化编排**：可视化编辑器拖拽编排 + AI Agent 自然语言辅助，两入口平权。
5. **嵌套复用**：子工作流嵌套 + 依赖快照，常用流程沉淀为可复用模板。
6. **能力按需加载**：功能组依赖在定义时声明、保存时静态校验、执行时懒加载。

## 二、技术栈

| 维度 | 技术选型 |
|---|---|
| **后端语言** | Python 3.12+（FastAPI Gateway + LangGraph 执行底座） |
| **执行引擎** | LangGraph `StateGraph`：checkpointer、interrupt、`Command(resume=)` 原生语义 |
| **前端** | Next.js 16 + React 19 + TypeScript，画布基于 React Flow |
| **图编辑** | React Flow（`frontend/src/components/workspace/workflows/`） |
| **能力抽象** | 功能组：版本化技能（semver + 不可变版本目录）+ custom agent 身份 + MCP 配置 |
| **外部工具** | MCP（stdio / http / sse）+ Sandbox（本地 / Docker / provisioner） |
| **数据存储** | SQLite 或 Postgres（LangGraph checkpointer / Store / 应用表共享同库） |
| **包管理** | 后端 uv，前端 pnpm |

## 三、系统分层架构

六层，自上而下单向依赖；「定义层 + 编译层」是 HNFlow 的核心新增，其余复用底层 harness。

```
┌─────────────────────────────────────────────────────────────┐
│ 用户交互层（Next.js）                                          │
│   ├── 对话界面（chat UI + SSE）                                │
│   └── 工作流画布（React Flow，/workspace/workflows/[id]）      │
├─────────────────────────────────────────────────────────────┤
│ 工作流定义层（backend/packages/harness/deerflow/workflow/）    │
│   ├── schema.py       节点/边/端口类型定义（Pydantic v2）      │
│   ├── workflow_io.py  定义校验 + JSON 序列化/迁移              │
│   └── registry.py     节点执行器注册表（幂等标注）             │
├─────────────────────────────────────────────────────────────┤
│ 编译层                                                       │
│   └── compiler.py     WorkflowDefinition → LangGraph StateGraph│
│       节点→图节点；边→普通边/条件边；端口→state 字段           │
├─────────────────────────────────────────────────────────────┤
│ 执行引擎层                                                    │
│   ├── worker.py       编排 run / checkpointer / SSE 事件       │
│   ├── executors/      ai / data / flow / human / tool          │
│   ├── prompts.py      三层提示词组装（身份→能力→任务）          │
│   ├── human_task_state.py  HumanTask 状态机                    │
│   └── delegate.py     运行期委派（子工作流 agent）             │
├─────────────────────────────────────────────────────────────┤
│ 能力层                                                        │
│   ├── skills/         版本化技能 + 依赖解析 + 命名空间前缀      │
│   ├── mcp / sandbox / subagents / extensions                  │
│   └── custom agents   agent_name → SOUL + 工具集               │
├─────────────────────────────────────────────────────────────┤
│ 基础设施层                                                    │
│   ├── persistence/    workflow_definitions / human_tasks 表    │
│   ├── runtime events  JSONL / DB 事件流（SSE 驱动）            │
│   └── user-scoped storage（定义按 user 隔离）                  │
└─────────────────────────────────────────────────────────────┘
```

**核心理念**：`WorkflowDefinition` 是纯 JSON（可序列化、可校验、可版本化），编译后变成 LangGraph `StateGraph`（可执行）。可序列化由定义层保证，可执行 / 断点 / 挂起 / 恢复全部继承 LangGraph 语义。

- **定义层与执行层解耦**：数据模型不引入 LangGraph 依赖。
- **不造新调度器**：流程控制全部转为 LangGraph 语义（条件边 = Route 函数）。
- **校验器是纯函数**：图结构无环（迭代 DFS）、单起点单终点、端口类型匹配、参数合法，供后端保存与前端画布实时校验共用同一套规则。

## 四、核心概念与数据模型

### 4.1 核心实体

| 实体 | 说明 |
|---|---|
| **工作流（Workflow）** | 节点与连线组成的有向无环图，可独立执行、可嵌套调用；定义即 `WorkflowDefinition` 纯 JSON |
| **节点（Node）** | 最小执行单元，含输入/输出端口、参数、能力组声明、主身份绑定 |
| **端口（Port）** | 数据输入/输出接口，类型枚举 `data/file/bool/enum`，连线时校验兼容性 |
| **功能组（Capability Group）** | 按领域划分的能力供给单元，AI 节点的工具与规则来源 |
| **人工任务（HumanTask）** | 挂起工作流等待人工处理的待办，状态机 `pending → submitted / skipped / reopened / expired` |
| **子工作流（Subworkflow）** | 引用另一 definition 的节点，支持编译期子图与运行期委派 |
| **checkpoint** | LangGraph 断点持久化，一个工作流实例 = 一个 thread_id |

### 4.2 数据模型（`workflow/schema.py`）

- `Port`：`{name, type: PortType, required, description}`。
- `Node`：`{id, type: NodeType, inputs: Port[], outputs: Port[], params, capability_groups[], agent_name}`。`agent_name` 是 AI 节点的主身份绑定（`None` = 默认 lead 身份）。
- `Edge`：`{source, source_port, target, target_port, condition?}`。
- `WorkflowDefinition`：`{id, name, version, nodes, edges, metadata}`。
- `WorkflowMetadata`：`{resolved_groups, created_at, updated_at, pending_review_nodes}`。

约束：
- `id` 校验为稳定标识（`^[A-Za-z0-9_-]{1,64}$`），禁止路径字符（落盘安全依赖此约束）。
- `Port.type` 用枚举，禁止字符串自由值。
- 模型 `extra="forbid"`，禁止宽松 dict。

### 4.3 端口数据流

节点间仅通过端口传数据，端口经 state 字段流转，字段命名 `wf:<node_id>:<port>`，由 compiler 绑定；节点执行函数与 state 解耦。同名端口因带 node_id 前缀而互不覆盖，reducer 语义默认「覆盖」。

## 五、功能组体系

功能组是 AI 能力的抽象单元，是「一组按领域划分的能力」的一等公民。

### 5.1 组成与实现映射

| 能力维度 | 实现 |
|---|---|
| 工具/技能 | 版本化技能（`skills/`），`allowed-tools` 声明可用工具 |
| 规则 | 技能正文 + rules 并入提示词能力层 |
| 身份 | custom agent（`agent_name` 绑定 config + SOUL），一节点一主身份，避免人格冲突 |
| MCP | 全局 MCP 配置（`extensions_config.json`），经技能/工具集供给 |

### 5.2 版本化存储

- **GUID 不变性**：安装时生成 GUID，改名/移动写入 aliases，引用永远有效；路径仅用于展示与语义理解。
- **语义版本 + 不可变版本目录**：布局 `<root>/{public,custom}/<name>/v<semver>/SKILL.md`，已发布版本目录只读，修改 = 创建新版本；写路径走原子替换。
- **旧布局迁移**：无版本目录的旧技能迁移到 `v0.1.0`（`scripts/migrate_skills_versioned.py`）。
- **当前版本选择**：未指定版本时取版本列表最高者。

### 5.3 依赖解析

- frontmatter 声明 `dependencies: [{guid, versionRange}]`。
- 保存工作流时递归收集节点功能组依赖，固化为 `resolved_groups`（`guid@v<version>` 集合）落盘。
- 静态校验存在性、版本范围，并做跨实体循环检测。
- **统一依赖图**（`dependency_graph.py`）：聚合「工作流→子工作流、功能组→功能组、功能组→工作流」三类引用，全局 DFS 循环检测，输出完整循环路径。

### 5.4 命名空间工具前缀

同名工具自动加 `{group_namespace}.{tool_name}` 前缀，从机制上杜绝覆盖冲突；前缀改写发生在工具装配层，不侵入单个工具实现。

## 六、节点体系

节点按类型分六类，`id` 后为 `NodeType` 枚举值。

### 6.1 流程控制（flow）

| 节点 | 说明 |
|---|---|
| `flow:start` | 工作流入口，无输入触发一次 |
| `flow:end` | 终止节点，收集最终结果 |
| `flow:if` | 条件分支，按真值路由 true/false 端口 |
| `flow:switch` | 多分支，按 `params.cases` 匹配点亮分支端口 |
| `flow:loop` | 循环，输出 `iteration`/`out`（简单版） |
| `flow:parallel` | 并行 fan-out/fan-in 透传（LangGraph 原生多出边并行） |
| `flow:wait` | 延时，按 `params.duration` 秒睡眠后透传 |

### 6.2 数据操作（data）

`data:assign`（赋值/透传）、`data:convert`（类型转换）、`data:file`（沙箱文件读写）、`data:json`（stringify/parse）、`data:regex`（正则匹配/替换）。

### 6.3 工具调用（tool）

`tool:bash`（沙箱命令，**必须走 sandbox**）、`tool:http`（HTTP 请求）、`tool:notify`（用户通知）、`tool:log`（日志透传）。

### 6.4 AI（ai）

`ai:llm_agent`——三层提示词 + 受限执行体，见第七节。

### 6.5 人工（human）

`human:task`——挂起并生成 HumanTask，见第八节。

### 6.6 嵌套（nested）

`nested:subworkflow`——编译期子图或运行期委派，见第九节。

## 七、AI 节点

### 7.1 三层提示词

AI 节点提示词运行时按**身份 → 能力 → 任务**三层拼装（`workflow/prompts.py`，纯函数）：

```
身份层：agent_name 对应 custom agent 的 SOUL（None → 默认 lead 身份）
能力层：关联功能组的 rules / 工具描述 / allowed-tools 并集
任务层：节点 instruction 模板（画布上写，每节点一份），支持 {{port}} 插值
```

- 一个 AI 节点 = 一个主身份 + 若干能力供给组（能力并集），避免人格冲突。
- 任务层模板必填，留空保存校验报错。
- **AI 节点 ≠ 自由 ReAct loop**：节点内只能调用关联功能组声明的工具，LLM 只决策「调用哪个工具、按模板产出什么」。

### 7.2 双端口会话模式

| 输入端口 | 有值行为 |
|---|---|
| `template_prompt` | **reset 模式（默认）**：模板 + 端口输入全量重跑，历史清空，适合确定性模板任务 |
| `continue_prompt` | **continue 模式**：新提示词 append 到该节点既有会话，resume checkpoint 继续，适合迭代任务 |

- 优先级定死：`continue_prompt` 有值 → continue；否则 → template。
- 会话 key 稳定：`checkpoint_thread_id = {origin_thread_id}:wfai:{node_id}`，跨 run 经 context 注入 `ai_origin_thread_id` 定位旧会话。
- continue 仍限关联功能组工具，loop 迭代次数即硬上限。

### 7.3 执行体

- 复用受限 SubagentExecutor 执行（非自由 lead 会话）。
- 工具集 = 主 agent 工具 + 全部关联功能组 allowed-tools 并集。
- 非幂等：`idempotent=False`，重试需人工确认。

### 7.4 Token 与缓存观测

- 节点 `token_usage`（含稀疏 `cache_read_tokens`）经保留通道由 worker 聚合进 `run.end.content["token_usage"]`。
- 无用量节点保持 absent，绝不补零；`get_workflow_run` 暴露可选 `token_usage`。

## 八、人工节点与统一挂起

### 8.1 HumanTask 生命周期

- 工作流执行到人工节点 → 挂起 `WaitingForHuman`，生成持久化待办。
- 待办含任务描述、上游输入快照、`output_spec`、`validation_rules`。
- 状态机（`workflow/human_task_state.py`，纯函数 + 转移表）：
  `pending → submitted / skipped / reopened / expired`。
- 用户提交后按 `output_spec` + `validation_rules` 校验（格式/必填/命名），通过则流程继续；失败回 `reopened` 打回重交。
- 支持跳过（`{"__skip": True}`）。

### 8.2 统一挂起（AI 中断 = 人工节点）

- AI 节点内部 LangGraph `interrupt()` 统一转化为 HumanTask 待办，外层封装层无需感知内部类型。
- **主键绑定**：以 HumanTask ID 为持久化主键，记录 checkpoint 引用。
- **恢复链路**：提交/跳过 → 按记录定位 checkpoint → `Command(resume=...)` 恢复对应节点，传入用户提交值。
- 恢复失败时任务回 `pending`，不丢用户输入。
- 状态与命令复用 LangGraph/现有 run 生命周期，不引入新执行循环。

## 九、子工作流与嵌套

### 9.1 两种模式

| 模式 | 实现 | 特点 |
|---|---|---|
| **编译期子图** | definition 引用另一 definition，compiler 内联展开为嵌套 `StateGraph` | 自动获得子图 checkpointer / 错误传播 |
| **运行期委派** | 节点执行 = 增强版 task_tool，委派子工作流 agent 执行 | 子代理 `checkpointer=True`，递归按需放开 |

### 9.2 隔离与边界

- 子图 state 与父图 state 分离，仅通过端口映射通信。
- **写时复制边界**：跨子图边界做浅复制（`_copy_on_write`），不 deepcopy，保持大值嵌套共享。
- 编译前做嵌套深度限制（默认 ≤10 层）与全局依赖图循环检测，报完整引用链。

## 十、执行引擎

### 10.1 编译与执行

- `compiler.py`：`compile_definition(def, context) → CompiledStateGraph`；节点→图节点、边→普通边/条件边；编译产物按 definition 哈希缓存，变更自动失效。
- `worker.py`：接收 definition id + 输入参数 → 编译 → `graph.astream(..., stream_mode=["updates","custom"])` 执行。

### 10.2 run 生命周期与事件

- 复用 run 生命周期：RunRecord、checkpointer、run events（JSONL/DB）、SSE 节点级事件 `wf:node:started|completed|failed`。
- 一个工作流实例 = 一个 thread_id；子图/并行分支用不同命名空间隔离状态。
- 取消/超时复用现有取消机制。

### 10.3 断点续跑

- LangGraph checkpointer（sqlite/postgres）覆盖整图（含子图）。
- 每步执行状态持久化，进程崩溃后重启可从断点恢复。
- 挂起（人工待办）状态同样持久化，重启后仍在待办列表。

### 10.4 幂等与确认

- 每个节点显式标注 `idempotent`（`registry.py`）。
- 非幂等节点（`tool:bash` / `tool:http`）标注 `requires_confirmation`，留 crashConfirm 钩子，失败不自动重试，转人工确认。

## 十一、外部工具连接与沙箱

### 11.1 MCP

- 支持的传输：stdio / http / sse；OAuth；session pool；`tool_search` 懒加载；路由提示。
- MCP 工具可作为 AI 节点工具集来源（经功能组/工具装配层）。

### 11.2 Sandbox

- 多模式：本地 / Docker / provisioner(K8s)。
- `tool:bash` 等命令类节点强制走沙箱执行（`Sandbox.execute_command`），**禁止直连宿主 shell**。
- 文件读写同受沙箱文件系统约束。

### 11.3 工具节点

`tool:bash`/`tool:http`/`tool:notify`/`tool:log` 为内置原子工具节点；AI 节点的工具调用走其受限执行体。

## 十二、对话侧调度

lead agent 内置工作流工具，与画布走**同一套 API**（双入口一致性，无旁路）：

| 工具 | 作用 |
|---|---|
| `generate_workflow(prompt)` | 自然语言 → WorkflowDefinition，过校验器（失败自动修正重试 ≤2 次）后保存；危险节点默认带「待审核」标记 |
| `edit_workflow(definition_id, instruction)` | 读现有定义 + 指令完整重生成，更新同一 definition_id |
| `run_workflow(definition_id, params, wait)` | 启动运行；`wait=True` 轮询至终态并聚合节点进度，`wait=False` 后台执行 |
| `get_workflow_run(run_id)` | 反复查询运行进度（含可选 token_usage） |
| `continue_node(run_id, node_id, prompt)` | 对 AI 节点会话追加提示词继续执行 |
| `list_human_tasks` / `submit_human_task` / `skip_human_task` | 查询待办、提交（校验后触发 resume）、跳过 |
| `pause_workflow` / `resume_workflow` / `cancel_workflow` | 运行控制（包装 run API） |

约束：生成结果必须通过图结构校验才可保存（「Agent 只能调用已注册能力」的强制边界）；异常修复的自动重试仅限幂等节点，非幂等节点失败转人工确认。对话侧工具经 Gateway 运行单例与画布共用同一 run 生命周期，失败时聚合 `wf:node:*` 事件给出修复信息。

## 十三、数据存储与隔离

- 统一 `database` 配置选择 SQLite 或 Postgres：LangGraph checkpointer / Store / 应用表共享同库。
- 应用表：`workflow_definitions`（id/user_id/name/schema_version/definition/metadata/resolved_at）、`human_tasks`（id/run_id/node_id/status/描述/输入快照/输出规范/校验规则/checkpoint 引用/user_id）。
- **原子写入**：临时文件 → fsync → 原子替换。
- **用户隔离**：`user_id` 作用域存储，多用户同名工作流互不可见；无鉴权模式 fallback `default`。
- 产品形态为本地部署，协作通过导入导出 + Git 实现。

## 十四、安全

- **默认 loopback 绑定**：compose 入口默认 `127.0.0.1:2026`，不暴露公网。
- **沙箱隔离**：命令类节点强制走 Sandbox，禁止直连宿主 shell；文件写入受沙箱约束。
- **危险节点待审核**：AI 生成的 `tool:bash` / `tool:http` 默认写入 `pending_review_nodes` 元数据；`run_workflow` 启动时 pre-flight 拦截待审核节点，执行器的 `crash_confirm` 门是最终强制边界。
- **非幂等人工确认**：涉及覆盖、提交、删除、发布等操作不自动重试，转人工确认。
- **依赖静态校验**：功能组依赖存在性、版本范围、循环引用在保存时静态拦截。
- **生成必校验**：任何 AI 生成的工作流必须过图结构校验才可保存。

## 十五、关键设计原则

1. **领域无关**：核心引擎不绑定任何领域，能力通过功能组插件化接入。
2. **定义/执行解耦**：`WorkflowDefinition` 纯 JSON 可序列化；执行全部交 LangGraph 语义。
3. **不造新调度器**：流程控制转为条件边/普通边，出错行为沿用 LangGraph 默认。
4. **GUID 不变性**：功能组 GUID 创建后终身不变，路径仅用于展示与语义理解。
5. **版本不可变**：每个版本目录是只读快照，修改即创建新版本。
6. **节点锁定版本**：依赖固定 `guid@version`，新版本只提示不自动更新。
7. **按需加载**：功能组内容执行到对应节点时懒加载，实例生命周期内缓存复用。
8. **身份唯一**：一个 AI 节点一个主身份，能力可并集，禁止隐式多身份路由。
9. **人工一等公民**：人工节点与 AI 中断统一为 HumanTask，对外层透明。
10. **状态强持久化**：每步落盘，异常退出无损恢复。
11. **运行时只读**：工作流执行时画布禁止编辑结构，防止两侧状态不一致。
12. **原子写入**：所有文件写入采用临时文件 + 原子替换。
13. **能力边界透明**：Agent 通过功能组命名空间理解能力边界，生成必校验。
14. **防递归**：嵌套前做循环引用检测，设最大嵌套深度（默认 10 层）。

## 十六、后续规划

以下为当前设计尚未覆盖、按需排期的开发方向：

- **容错编排**：Try-Catch / Finally 节点，子图异常捕获走 catch 分支；失败降级与失败回调。当前流程控制仅 if/switch/loop/parallel/wait。
- **并发治理**：并行分支上下文隔离与可配置合并规则（后者覆盖/数组合并/冲突报错）、共享变量机制；外部软件实例级互斥的资源锁管理器（可重入锁 + 跨进程文件锁 + 统一加锁顺序）。
- **工具节点化**：MCP 工具直接调用节点（`mcpTool`），当前 MCP 仅经 AI 节点工具集可用。
- **调试能力**：节点断点、单步、回退重跑；当前仅有事后调试面板（日志/变量/节点状态）。
- **功能组版本生态**：功能组管理 UI、版本通知与一键升级、语义版本分级、接口兼容性报告；子工作流模板独立语义版本与引用锁定；`requiresCoreVersion`；`.hnflow-group` 导出导入与版本废弃标记。
- **Loop 正宗版**：子图展开 + 条件边 + `results`/`last` 聚合输出（当前为简单版：`iteration` 轮次计数 + `out` 透传）。
- **成本与缓存优化**：缓存感知执行顺序规划器（观测已落地，规划器待 benchmark 后立项）；AI 节点级动态工具裁剪（子集选择 / 动态检索 / Token 预算联动）。
- **复杂任务分诊**：由画布条件边显式路由承载，不放开节点内自由路由。
- **执行数据分析**：节点耗时统计、瓶颈识别、Token 预算告警 UI。
