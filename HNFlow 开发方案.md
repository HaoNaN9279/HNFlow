# HNFlow 开发方案

> 本文件是 HNFlow 的目标架构与开发方案。它取代“所有能力直接绑定某个 Agent 框架”的实现路线，改为：
>
> **LangGraph 负责图编排，React Flow 负责编辑体验，HNFlow 自己拥有运行/能力/人工治理面，Agent 通过窄端口接入；DeerFlow 是默认 Agent 适配器，但不是唯一实现。**
>
> 当前实现状态与约束见 [AGENTS.md](AGENTS.md)、[backend/AGENTS.md](backend/AGENTS.md) 与 [frontend/AGENTS.md](frontend/AGENTS.md)。

---

## 一、定位与设计目标

HNFlow 是**图驱动的确定性工作流编排引擎**，面向单机个人用户，作为本地专业软件与长期流程的“流程管家”。

核心设计目标：

1. **图驱动、可复现**：流程拓扑、端口、人工节点、失败路径由 `WorkflowDefinition` 明确定义，同输入同路径。
2. **本地软件一等**：Blender / Unity / Photoshop / CAD / DAW / GIS / IDE / MATLAB 等应用经应用接入层驱动，是核心执行对象。
3. **长期运行**：实例可存活数天/数周，具备调度、断点、恢复、资源治理与归档。
4. **单用户本地**：默认回环绑定，数据留本机；不做多租户、RBAC、市场分发。
5. **人机协同**：人工审核、修改、跳过、打回重交、审批、断点、单步是一等能力。
6. **AI 受控**：AI 节点是图中的一个受预算、工具集、输出契约约束的执行单元，不是自由旁路。
7. **可替换 Agent**：AI 执行器通过稳定端口接入；更换 Agent 不改图、不改编译层、不改前端。
8. **能力可治理**：所有工具经工具网关；MCP 是 provider 之一；权限、审计、幂等、预算在 HNFlow 侧统一裁决。
9. **可复现靠快照**：定义修订、能力版本、模型、prompt/tool schema hash、录制回放共同保证可追溯。
10. **领域无关**：核心不绑定游戏引擎或专业软件；领域能力经能力包/技能/子工作流插件化接入。

### 非目标

- 不做云端多租户 SaaS、组织级 RBAC、市场分发。
- 不把“任意 Agent”当作地基；外部 Agent 只能作为可替换执行器，不能绕过 HNFlow 的工具、权限、人工与副作用治理。
- 不重写 LangGraph 的图执行/checkpoint/interrupt 语义。
- 不要求 AI 节点内部完全确定；确定性边界在**图、端口、工具调用、人工节点**，AI 内部用录制/回放与语义断言约束。

---

## 二、架构原则

1. **控制面与执行面分离**：图状态、run 生命周期、人工任务、调度、工具执行由 HNFlow 控制面拥有；Agent 只负责“思考循环”。
2. **Agent 是 SPI，不是运行时**：`AgentPort` 是唯一接入点；DeerFlow、LangGraph 子图、本地 CLI、HTTP Agent 都是适配器。
3. **工具必须回到 HNFlow 执行**：Agent 只能产生 `tool_call` 请求；真实执行、权限裁决、审计、幂等、沙箱由 HNFlow 完成。
4. **定义不可变**：每次保存产生新修订；run 钉住修订，resume/rewind/continue 不读取“当前最新定义”。
5. **单一线程真相**：一个 workflow run 对应一个 LangGraph thread；Agent 自己的会话只能作为该节点下的子会话，不能成为第二套图状态。
6. **契约先行**：定义、run 事件、AgentPort、ToolDescriptor、HumanTask 都有版本化契约；前后端类型/校验由契约生成或共享。
7. **模块化单体优先**：默认单进程部署；需要隔离时再把 Agent/Sandbox/App 放到进程边界，不提前微服务化。
8. **失败透明**：缺依赖、缺能力、版本不匹配、端口未产出，默认 fail-loud；禁止用空工具集/空上下文静默降级。

---

## 三、分层架构

```
┌──────────────────────────────────────────────────────────────┐
│ 体验层  Next.js + React Flow                                  │
│ 画布、运行面板、人工任务、审批、断点/单步、成本/耗时           │
├──────────────────────────────────────────────────────────────┤
│ 定义层  WorkflowDefinition / JSON Schema / 迁移                │
│ 纯 JSON、可序列化、可校验、不可变修订                           │
├──────────────────────────────────────────────────────────────┤
│ 编译层  compiler                                               │
│ 节点→图节点、边→普通边/条件边、端口→state channel              │
├──────────────────────────────────────────────────────────────┤
│ 编排层  LangGraph                                              │
│ StateGraph、checkpoint、interrupt、subgraph                    │
├──────────────────────────────────────────────────────────────┤
│ 运行层  HNFlow Run Service                                     │
│ run 生命周期、事件日志、SSE、人工任务、调度、资源锁、undo       │
├──────────────────────────────────────────────────────────────┤
│ 能力层  ToolGateway / Sandbox / App Bridge / Assets            │
│ 工具、权限、审计、幂等、本地软件、文件/资产、知识/记忆          │
├──────────────────────────────────────────────────────────────┤
│ Agent 层  AgentPort                                            │
│ DeerFlowAdapter / LangGraphAdapter / CLIAdapter / HTTPAdapter   │
├──────────────────────────────────────────────────────────────┤
│ 基础设施  SQLite/Postgres、事件存储、可观测、回放夹具           │
└──────────────────────────────────────────────────────────────┘
```

依赖方向自上而下。**定义层不依赖 LangGraph、Agent、数据库或 Web 框架**；编译层只依赖定义层和 LangGraph；运行层依赖能力层与 AgentPort，不反向依赖具体 Agent。

---

## 四、AgentPort：可替换 Agent 的唯一接入口

### 4.1 端口定义

```python
class AgentPort(Protocol):
    manifest: AgentManifest

    async def start(self, request: AgentTurnRequest) -> AgentTurnHandle: ...
    async def stream(self, handle: AgentTurnHandle) -> AsyncIterator[AgentEvent]: ...
    async def resume(self, handle: AgentTurnHandle, value: Any) -> None: ...
    async def cancel(self, handle: AgentTurnHandle) -> None: ...
```

`AgentTurnRequest`：

- `task` / `system_prompt`
- `tools: list[ToolDescriptor]`
- `tool_executor`：由 HNFlow 提供的工具调用回调
- `thread_id` / `node_id` / `attempt` / `idempotency_key`
- `budget`：`max_turns` / `max_tokens` / `timeout`
- `model_policy`
- `required_capabilities`
- `session`：可选的 Agent 会话句柄（仅用于 continue）

`AgentEvent`：

- `text_delta`
- `tool_call` / `tool_result`
- `usage`
- `interrupt`
- `artifact`
- `done` / `error`

### 4.2 能力等级

不承诺“任意 Agent 全能力可用”。节点声明所需等级，编译期/准入期校验：

| 等级 | 能力 | 缺少时的行为 |
|---|---|---|
| T0 | 文本输入/输出 | 只能用于最小 AI 节点 |
| T1 | 流式输出 | 可用，但无实时 UI |
| T2 | 工具调用（经 HNFlow） | 不可声明工具型节点 |
| T3 | 中断/恢复 | 不可用于人工审批/断点内嵌 |
| T4 | 资产/本地应用工具 | 不可用于本地软件节点 |
| T5 | token/成本归因 | 成本报表为空，不伪造 0 |

### 4.3 所有权矩阵

| 能力 | HNFlow | Agent |
|---|---|---|
| 图状态 / checkpoint | 拥有 | 不可见 |
| run 生命周期 / 取消 | 拥有 | 不可见 |
| 人工任务 / 审批 / 断点 | 拥有 | 只能上报 interrupt |
| 工具执行 / 权限 / 审计 | 拥有 | 只能请求 tool_call |
| 文件 / 宿主 / 本地应用 | 拥有 | 不可直接访问 |
| 密钥 | 拥有 | 按请求注入，不落 prompt/log/checkpoint |
| 成本归因 | 拥有 | 上报 usage |
| 思考循环 / 模型选择 | 约束 | 在允许范围内自主 |
| 内部提示词 | 提供身份/能力/任务层 | 可追加内部推理策略 |

**边界规则：Agent 永远不能直接执行宿主命令、写宿主文件、启动本地应用或读写密钥。** 这些动作必须回到 HNFlow 的能力层。

---

## 五、工作流定义与编译

### 5.1 定义模型

- `Port`：`{name, type, required, description}`；类型 `data/file/bool/enum/number/array/record`。
- `Node`：`{id, type, inputs, outputs, params, capability_groups, agent_name}`。
- `Edge`：`{source, source_port, target, target_port, condition?}`。
- `WorkflowDefinition`：`{id, name, version, nodes, edges, metadata}`。
- `WorkflowMetadata`：`resolved_groups`、`lockfile`、`pending_review_nodes`、`shared`、`budget`、`evals`、`canvas`（纯 UI 数据）。

约束：

- `id` 稳定、禁止路径字符；
- `extra="forbid"`；
- `params` 由**每种节点类型的 Pydantic ParamModel**约束，不再使用裸 `dict[str, Any]` 作为唯一契约；
- 保存、编译、前端校验共用同一语义校验器。

### 5.2 编译

`compile_definition(definition, context) -> CompiledStateGraph`：

- 节点→LangGraph 节点，边→普通边/条件边；
- 端口→state channel：`wf:<node_id>:<port>`；
- 保留通道使用 `__` 前缀，不进入节点事件输出；
- 子图展开、循环、try/finally、handoff 由编译层原生处理；
- 编译上下文必须完整携带：`executors`、`previews`、`checkpointer`、`definition_resolver`、嵌套/委派深度限制；
- 编译使用**单一工厂**构造，禁止调用方拆 `build_context().executors`。

### 5.3 运行修订

- `workflow_definitions` 只指向当前修订；
- 每次保存新增不可变修订：`definition_id`、`revision`、`content_hash`、`definition`、`metadata`；
- run 记录 `definition_revision_id` + `content_hash`；
- resume / rewind / continue 只从该修订加载；缺失或 hash 不符 → 拒绝，不回退到最新版；
- 模板引用按 `(template_id, version)` 解析到修订，不再忽略 `version`。

---

## 六、执行模型

### 6.1 节点类别

- **flow**：start / end / if / switch / loop / parallel / wait / try / handoff
- **data**：assign / convert / file / json / regex / shared / knowledge / asset
- **tool**：bash / http / notify / log / invoke
- **ai**：llm_agent（经 AgentPort）
- **app**：launch / script / wait / collect
- **human**：task
- **nested**：subworkflow

### 6.2 执行器契约

统一异步契约：

```python
async def execute(ctx: WorkflowRuntimeContext, params: ParamModel, inputs: dict) -> dict
```

- 禁止在事件循环上做同步沙箱/文件/指纹 IO；必须 `asyncio.to_thread` 或专用 IO executor；
- 同步 executor 允许保留，但由运行层统一 offload，不能直接调用；
- 工具执行、文件、资产、preview 全部走能力层。

### 6.3 AI 节点

- 系统提示词：身份层 + 能力层 + 示例 + 上下文 + 输出契约；
- 任务层：仅节点 `instruction` 插值结果，作为 Agent 的 `task` 输入；
- **不得把完整系统提示词同时作为任务重复发送**；
- 工具集 = 能力包 allowed-tools 并集，经工具网关装配并按权限裁决；
- 输出契约、上下文预算、记忆/检索、模型路由均为节点级显式参数；
- continue 模式只对 Agent 会话追加任务层，不重复身份/能力层。

### 6.4 本地应用

- 运行在宿主，是“命令必须走 sandbox”的显式例外；
- 通过 App Bridge 驱动，驱动调用离事件循环；
- 资源/License/人机共享按应用注册表声明治理；
- Agent 只能请求 app 工具，不能直接启动进程。

---

## 七、能力面

### 7.1 工具网关

所有工具经 `ToolGateway`：

- 统一描述符：id / 语义名 / schema / provider / version / permissions / idempotent / side-effect；
- 调用信封：权限裁决 → provider 路由 → 结果归一 → 审计/成本 → 幂等/crash-confirm；
- provider：builtin / sandbox / mcp / app；
- AI 节点与 `tool:invoke` 都从同一网关取工具；
- Agent 不能自行发现/执行工具；只能接收 HNFlow 授予的 ToolDescriptor 与回调。

### 7.2 沙箱

- `tool:bash` 必须走 `Sandbox.execute_command`；
- 文件读写走 Sandbox；
- 沙箱执行是阻塞 IO，必须离事件循环；
- 本地沙箱是单机默认，Docker 为可选隔离。

### 7.3 能力包

- 版本化目录 + GUID；
- `permissions` / `evals` / `tool-schema-version` / `context-budget` / `required-secrets`；
- 保存定义时解析 `resolved_groups`；运行前按 lockfile 的 `guid@version` 解析；
- 版本缺失 fail-loud，不按名称静默使用最新版。

### 7.4 资产、知识、记忆

- 资产以 `AssetRef` 流转，宿主↔沙箱受 `assets.roots` 约束；
- 知识/记忆是可插拔 store；
- 检索/记忆注入受 token 预算约束；
- 记忆/检索失败只告警，不阻塞节点；
- 读取到的记忆/检索内容必须标记 untrusted 并中和框架标签。

---

## 八、人工任务与统一挂起

- `human:task`、审批、断点、单步统一为 HumanTask；
- 通过 LangGraph `interrupt()` 挂起；主键 `(run_id, node_id)` 保证 resume 不重复建任务；
- 任务必须有正确 `user_id`、`workflow_run_id`、`node_id`、`checkpoint_ref`；
- 提交/跳过/打回走 HumanTask 状态机；
- 审批在节点执行前挂起，冻结 preview 快照，批准后复验目标指纹；
- 断点不产生副作用；单步是 run 级开关，resume 时按任务 kind 重新推导；
- 任务列表按用户隔离，不能出现 `user_id=""` 的孤儿任务。

---

## 九、运行生命周期、事件与调度

- 一个 workflow run = 一个 thread；
- run 状态：pending / running / interrupted / success / error / timeout；
- 终态必须写一条结构一致的 `run.end`：`status`、`error`、`token_usage`、`node_timings`、`output_summary`；
- 事件：`wf:node:started|completed|failed`，节点事件只含声明端口；
- SSE 走 StreamBridge；断线重连用 `Last-Event-ID`，缺口返回 `stream_replay_gap`；
- 调度层：cron / once / file / app event / idle；幂等键、去重、退避、DLQ；
- 长等待不得用 `asyncio.sleep` 占用 run；持久化定时器或转 scheduler；
- 取消是协作 + task cancel；终态与事件必须一致。

---

## 十、可复现性

### 10.1 lockfile

每次保存/运行固化：

- 定义修订 + content hash；
- 能力包 `guid@version`；
- Agent 适配器版本；
- 模型 id/版本；
- prompt hash；
- 工具 schema hash；
- MCP server 版本；
- 采样参数。

lockfile 必须在运行时可被消费，否则只是装饰。

### 10.2 回放

- data/flow/tool 天然确定；
- AI/外部调用录制 `(input_digest → output)`；
- 回放模式跳过真实 Agent/工具调用；
- 敏感字段脱敏；
- 回放夹具与 lockfile 关联。

### 10.3 评测

- 定义内嵌 `metadata.evals`；
- 保存门 opt-in：`require_pass=true` 才阻塞；
- 确定性端口精确断言，AI 端口语义断言；
- 失败给出节点/端口级错误；
- CI 与能力包导入共用断言核心。

---

## 十一、前端与 React Flow

- React Flow 只负责编辑与可视化，不拥有定义真相；
- 后端 schema 是唯一来源，前端类型/校验由 schema 生成或共享；
- 画布位置写入 `metadata.canvas`，这是显式 UI 数据，不是运行语义；
- 保存时做乐观并发（revision / If-Match），冲突返回 409；
- 运行中画布只读；
- 运行面板只消费 Run/Event/State/Cost API，不直接读 checkpoint 文件；
- 人工任务/审批/断点/单步复用同一 HumanTask API。

---

## 十二、持久化与数据

- SQLite 默认，Postgres 可选；
- 共享库：checkpointer、run store、event store、应用表；
- 表：`workflow_definitions`、`workflow_definition_revisions`、`runs`、`run_events`、`human_tasks`、`workflow_undo_records`、`app_instances`；
- 定义保存原子写；修订不可变；
- `schema_version` 参与读取/迁移，DB 读取不得绕过迁移链；
- 单用户默认 `user_id=default`；共享机器可选弱隔离；
- 备份/迁移通过 CLI + 数据目录导出，不提供在线 HTTP import。

---

## 十三、安全

- 默认 `127.0.0.1:2026`，不暴露公网；
- 命令类节点强制走 Sandbox；
- 危险节点默认待审核；
- 不可逆操作走 preview + approval + compensation/undo；
- 工具级最小权限；
- 外部内容（web/MCP/文件/记忆）标记 untrusted，注入前中和；
- 密钥请求级注入，不进 prompt/log/checkpoint/run record；
- 外部 Agent 不得直接访问宿主；远程 Agent 只接收工具回调与资产引用。

---

## 十四、测试策略

当前全量后端测试 11k+，串行 `-v` 成本高。测试分层：

1. **纯函数/定义/校验**：无 IO，毫秒级；
2. **workflow 聚焦集**：`make test-workflow`，只跑 `tests/test_workflow_*.py`；
3. **契约测试**：HTTP → Run Service → Worker → AgentPort → ToolGateway 的最短端到端路径；
4. **并行全量**：`pytest -n auto --dist loadfile`（需本地安装 `pytest-xdist`）；
5. **阻塞 IO 门禁**：`make test-blocking-io`，workflow executor/preview 必须有锚点；
6. **回放/评测**：不调用真实模型/工具，作为 CI 快检。

关键契约测试必须覆盖：

- 保存含 `metadata.canvas` 的定义；
- `human:task` 在真实 worker 中创建后，`/api/human-tasks` 可见并可提交；
- `require_approval` 与 `params.idempotency` 在真实 `run_workflow` 中可用；
- full/delta 两种 checkpoint 模式下 `/state`、`/cost` 一致；
- 修改定义后 resume/rewind 仍使用 run 钉住的修订；
- bash/file 节点执行期间其他 run 的 SSE 心跳不被阻塞。

---

## 十五、迁移路线

采用绞杀式改造，不重写：

1. **契约冻结**：定义 schema、run event、AgentPort、ToolDescriptor、HumanTask。
2. **运行时装配收敛**：唯一 compile context / runtime context / Run Service。
3. **P0 修复**：审批、人工任务、工具节点、state/cost、IO 阻塞。
4. **修订钉住**：不可变定义修订 + run snapshot + lockfile 消费。
5. **AgentPort 落地**：DeerFlow 作为默认适配器；外部 Agent 按 T0-T5 能力等级接入。
6. **前端契约生成**：停止手写镜像校验。
7. **可观测/评测/回放**：统一事件与报告。

每一步都必须有聚焦测试，且不破坏现有工作流。

---

## 十六、关键决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 是否用“任意外接 Agent”做地基 | 否 | 会丢失工具治理、本地软件、HITL、可复现 |
| 是否重写掉 DeerFlow | 否 | DeerFlow 已提供能力面；重写成本高于抽端口 |
| 是否微服务化 | 默认否 | 单机个人部署，模块化单体更简单 |
| Agent 能否直接执行工具 | 否 | 权限/审计/沙箱/幂等会旁路 |
| 图状态归谁 | HNFlow/LangGraph | Agent 会话不能成为第二套图状态 |
| 定义是否可变 | 否，改为不可变修订 | resume/rewind 与可复现要求 |
| React Flow 是否拥有校验 | 否 | 后端 schema 单一来源 |
| 长等待是否用 sleep | 否 | 长期运行/重启恢复要求持久化定时器 |
