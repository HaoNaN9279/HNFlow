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

- `schema.py` — 节点/边/端口类型定义（Pydantic v2）：`Port`、`Node`、`Edge`、`WorkflowDefinition`。`PortType` 含 `data/file/bool/enum/number/array/record`（严格同类型匹配）。`Node` 含 `agent_name` 主身份绑定（`None` = 默认 lead 身份）与 `capability_groups`（能力供给组，allowed-tools 并集 + rules 并入 prompt）。`WorkflowMetadata` 含 `resolved_groups`、`pending_review_nodes`、`lockfile`（全量能力快照）与 `canvas`（纯 UI 画布数据：positions 与 labels；显式声明，避免前端保存被 `extra="forbid"` 拒绝）。`nested:subworkflow` 的 `params.subworkflow` 还承载前端保存语义：缺省/template 为跟随模板（全局），inline snapshot + `save_mode: "local"` 为仅保存到父工作流；后端编译器忽略该附加键。`id` 校验为稳定标识（uuid/slug），禁止路径字符。`collect_resolved_groups`（解析）+ `validate_capability_groups`（存在性校验）为纯函数。
- `workflow_io.py` — 定义校验器 + JSON 序列化：`validate_definition`（无环 DFS、单起点单终点、端口类型匹配，报错携带完整环路路径 `A→B→C→A`）、`serialize`/`deserialize`（schema version + `register_migration`/`_migrate_schema` 逐版本迁移链）。纯函数，前端画布复用同一套端口匹配规则。
- `compiler.py` — `compile_definition(def, context) -> CompiledStateGraph`：节点映射为 LangGraph 节点函数，边映射为普通边/条件边；端口→state 字段绑定（`wf:<node_id>:<port>`）；每个节点函数被包一层生命周期事件发射（`wf:node:started|completed|failed` 自定义事件，携带 `depth`，顶层为 0；事件 `output` **只含声明端口**——`__` 保留通道是引擎内部记账，经 run.end 聚合暴露，不污染节点事件）；子图展开（嵌套 StateGraph，边界 `_copy_on_write` 浅复制）；`flow:loop` 计数环 + C5 正宗版（节点声明 `results`/`last` 时逐轮聚合 body 产物，`params.continue_on` 为可选的 data 条件早退，`iterations` 仍是硬上限；N14ak 再支持 `params.subworkflow` 声明式 body：body 由 compiler 展开为生成节点（id `<loop>.body`，**不发射**节点事件——它不是画布节点），body 边与回边都由 params 生成，每轮的输入（第 1 轮种子 / 之后上一轮的结果，即 ring）经保留通道 `wf:<loop>:__ring` 往返（`params.seed_input`/`params.ring_port` 默认 `in`/`out`，显式指定却不存在即编译期报错；两个默认都缺省则可无 ring 的纯计数 body，此时不聚合任何东西）；`results`/`last`/`continue_on` 语义与内联 body 完全一致（`continue_on` 可指名入边源端口、body 经 `mapping.outputs` 暴露的汇报端口、或 body 的 ring 端口，指不到即编译期报错——声明式 body 的合法名是已知的），`mode: delegate` 被拒；画了条件出边 = 编译期报错（params 是路由唯一真相），必须且只能有一条无条件出边（出口）；body 失败不是 try（`<loop> > body > ...` 直接失败），`interrupt` 等控制流信号照常透传）；`flow:try`（N12）把 `params.subworkflow` 展开为受保护子图，捕获 body 失败（**排除** `GraphInterrupt`/`GraphBubbleUp` 等 LangGraph 控制流信号）写成 `error`/`error_message`/`error_type` 端口供下游 `flow:if` 分流到 catch 分支，可选 `finally_subworkflow` 在 `finally` 块执行；N13 并发治理：节点 `params.merge`（`{port: overwrite|array|error}`，默认 `overwrite`=最后边胜）对**同端口多入边**（并行分支汇聚）按策略合并——修复此前「dict 覆盖、静默只留最后一条」的缺陷——节点 `params.resource_lock`(str|list)+`resource_lock_timeout` 用 N8 跨进程锁包裹整段执行（锁持有线程+握手，不阻塞事件循环）；N14 共享工作区：`data:shared` 节点（`operation: read|write|append` + `name`）经保留结果键 `__shared_writes` 写 `wf:shared:<name>` 通道，写策略由 `metadata.shared` 声明（`overwrite` 默认 LastValue：跨步覆盖、同步并发写→冲突报错 / `array` 挂 reducer 使并行 append 合并 / `conflict`）；编译产物按 definition 哈希缓存，变更自动失效。
- `worker.py` — 编排入口：接收 definition id + 输入参数，调 compiler 编译，`graph.astream(..., stream_mode=["updates","custom"])` 执行；消费 compiler 的节点级自定义事件（仅 `depth == 0`）转 `wf:node:started|completed|failed` 到 SSE bridge + run events，`updates` 分块提供无 checkpointer 路径的 run.end 兜底；复用 run 生命周期（RunRecord、checkpointer、run events）。`runtime_context.py` 是唯一的 compile/runtime context 装配点：编译上下文必须完整携带 `executors`/`previews`/`idempotent_by_type`（缺一会让审批/重试在真实路径失效）；运行时上下文注入 `user_id`、`tool_gateway`、app session/instance repo、可选 memory/knowledge/notifier（缺 `user_id` 会生成不可见的 HumanTask）。`run_snapshot.py` 把 run 准入时的定义快照 + content hash 写进 run kwargs，resume/rewind/continue 优先使用该快照，legacy run 才回退当前定义。
- `workflow_definitions/revision_model.py` + `0020_workflow_definition_revisions` — 每次保存 definition 产生不可变修订（`definition_id + revision + content_hash + definition + metadata`）；run 侧仍以 `run_snapshot.py` 的 kwargs 快照保证 resume/rewind 不回退到最新编辑。保存路由在结构校验后执行一次 dry-run compile，把审批/重试/上下文策略等编译期错误提前为 422。
- `failure_taxonomy.py`（N14 §24.9）— 稳定失败码：`FAILURE_CODES`（`timeout|rate_limit|model|validation|tool|budget|resource|conflict|config|unknown`）+ 纯函数 `classify_failure(exc, *, node_type)`（best-effort 确定性映射，`unknown` 兜底；对 compiler/registry 等用函数内 deferred import 防循环）。节点失败时 `wf:node:failed`（compiler 包装层 + worker 兜底）与 `run.error` 携带 `error_class`（additive）。
- `executors/` — 节点执行器，统一签名 `executor(runtime, params, inputs) -> outputs`：
  - `flow.py` — if/switch/wait 流程控制（loop/parallel/try 为编译器原生：loop 输出 `iteration`/`out` + C5 的 `results`/`last`；try 展开 `params.subworkflow` body 子图并捕获失败到 `error`/`error_message`/`error_type` 端口，可选 `finally_subworkflow`）。`flow:if` 只写选中的分支端口（另一支写 `None`），router 按“值非 None”判定选中分支，因此路由不依赖画布边顺序，falsy 载荷（0/""/False）也不会丢分支。
  - `data.py` — assign/convert/file/json/regEx 数据操作；`data:shared`（N14）共享工作区黑板 read/write/append（写策略 `metadata.shared`，`array` 走 reducer）。
  - `knowledge.py` — `data:knowledge` 节点（N14）：`operation=retrieve|ingest`，从 `runtime.context["knowledge_store"]` 读/写本地知识库；retrieve 输出 `records`（带 `cite:` 引用）+ `out`（拼接文本），ingest 分块 upsert 并输出块数；无 store 时 fail-loud。
  - `asset.py` — `data:asset` 资产节点（N9）：inspect（读指纹）/ import（宿主→沙箱）/ export（沙箱→宿主）/ convert（声明式转换器），宿主访问受 `assets.roots` 白名单约束。
  - `tool.py` — bash/http/log/notify 工具节点；bash 必须走 sandbox（`Sandbox.execute_command`），禁止直连宿主 shell；notify 经 `runtime.context["notifier"]` 钩子（缺省回落日志）发出本机通知。N14 §24.7：`__idempotency_key`（compiler 注入）分别透传为 `tool:http` 的 `Idempotency-Key` 请求头 / `tool:bash` 的 `DEERFLOW_IDEMPOTENCY_KEY` 环境变量（调用方显式配置同名头/env 则尊重）。**§25 工具节点化**：`exec_tool_invoke`（`tool:invoke`）用图直接调用网关工具——`params.tool`（必填）+ 可选 `params.provider`（`sandbox`/`builtin`/**`mcp`**/`app` 消歧，未知 provider 不回落）+ `params.arguments`（支持 `{{port}}` 插值，嵌套 dict/list 递归、整值占位保留原类型、缺端口→空串）；网关取自 `runtime.context["tool_gateway"]`，**缺失即 fail-loud**（就地新建会解析出与准入时不同的工具集）。调用走**直调路径**（`tool.coroutine`/`func` + schema 校验 + 仅当签名声明 `runtime` 才传 `ToolRuntime`）——因为模块用了 `from __future__ import annotations` 时 `InjectedToolArg` 会退化成字符串、框架会把注入参数填成 `None` **并忽略 args 里的同名值**（已实测）；无函数可取的透明 `BaseTool` 子类回落框架路径。非幂等 + crash-confirm 门 + 默认待人工审核（`registry._NON_IDEMPOTENT_TYPES` / `danger._DANGEROUS_TYPES`），故也**拒绝 `params.retry`**。
  - `ai.py` — AI 节点模板模式：三层提示词组装 + 受限 Agent；identity/capability/examples/context/schema 作为 system prompt，节点 instruction 插值结果只作为 task（HumanMessage），**不得把完整系统提示词重复作为 task**；AI 节点只依赖 `workflow/agent_port.py` 的 `AgentPort`，默认 `DeerFlowAgentAdapter` 包装 `SubagentExecutor`；适配器 manifest 声明 T0-T5 能力，节点至少校验 `tools`；工具集 = 关联能力包 `allowed-tools` 并集，经 `tool_gateway.resolve_capability_tools` 装配（有序去重），`instruction` 模板必填。N14 §24.5 自主度预算：`params.autonomy = {mode: template|bounded, budgets: {max_turns, max_tokens}}`（`bounded` 把预算落到 `SubagentConfig.max_turns`/`token_budget`；`stop_reason` 经 reserved 通道 `wf:<node>:__stop_reason` 暴露；`max_tool_calls`/`delegated` 尚无机制，提供即编译期报错）。N14 §24.4 结构化输出：`params.output_schema = {fields: {name: PortType}, required?, enum_values?, max_repairs?}`（`workflow/structured_output.py` 纯逻辑；字段须映射到**类型一致**的已声明输出端口，编译期校验；模型输出经剥围栏/`json.loads`/校验，失败带错误**有界重试** ≤ `max_repairs`，耗尽即节点失败；修复次数经 reserved 通道 `wf:<node>:__schema_repairs` 暴露；仅 template 模式，`file` 字段类型与完整 JSON Schema 列后续）。N14 §24.3 上下文策略：`params.context_policy = {examples, include, budget:{total_tokens}}`——声明式 few-shot + 按名挂载输入端口 + 节点级预算（只约束可截断桶，`context` 先于 `examples` 丢弃），用量经 reserved 通道 `wf:<node>:__context_usage` 暴露；`include` 必须是已声明输入端口（编译期校验）；与 continue 模式互斥（运行期报错）。工具结果外置/历史压缩仍由全局中间件负责（节点级 override 列后续）。N14 §24.10 模型路由：`params.model_policy = {prefer: default|local|cheap|quality, require_local}`（`workflow/routing.py` 纯逻辑）据 `config.models[*]` 的 `local`/`cost_tier` 选择模型名写入 `SubagentConfig.model`；`require_local` 无本机模型即节点失败，绝不静默回退远程；与 continue 模式互斥（运行期报错）。N14 §24.2 知识检索：`params.retrieval = {collection, query?, top_k?, ctx_budget?, rerank?}`（`workflow/knowledge.py`）从 `runtime.context["knowledge_store"]` 检索带引用片段并前置 `<context>` 块（受预算约束，失败仅告警）；与 continue 互斥。N14 §24.1 节点级记忆：`params.memory` 从 `runtime.context["memory_store"]` 读注入/写回 `<memory>` 块（失败仅告警）；与 continue 互斥。
  - `local_app.py` — 本地应用节点（N4/N5）：`app:launch`/`app:script`/`app:wait`/`app:collect`，经 `deerflow/apps/` 接入层驱动本机专业软件；launch/script 非幂等且 crash-confirm 门，wait/collect 幂等；驱动调用经 `asyncio.to_thread` 离事件循环。
  - `human.py` — HumanTask 挂起。
- `tool_gateway.py` — 工具网关：`ToolDescriptor` + `ToolGateway`（provider 优先级分派，`resolve`/`resolve_with_provider` 支持 **provider 作用域**且**未知 provider 不回落**）+ sandbox/builtin/**mcp**/app provider，`resolve_capability_tools` 供 AI 节点装配工具（并集按 §5.5 `extends` 闭包解析，见 `skills/composition.py`）。**MCP 已收编为独立 provider**（N1 §9）：builtin 装配改 `include_mcp=False`，MCP 工具经 `get_cached_mcp_tools()` 单独成 provider 并保留 `tag_mcp_tool` 标记（deferred-tool 过滤依赖它）；无启用 server / 未装 MCP extra 时该 provider 为空（fail-open）。skill provider 无需实现（技能脚本经 sandbox 执行）。**N14 §24.12 最小权限裁决**：`resolve_capability_tools` 在装配前用 `skills/permission_policy.py` 按能力包声明的 `permissions`（`fs/net/exec/secrets`）过滤工具——**opt-in**（未声明权限的组不受限，行为不变）、组内对**无法归类**的工具 **fail-closed**（拒绝并点名 `tool-permissions` 这个可声明它的旋钮），声明经 `composition` 继承并取并集。
- `preview.py` / `approval.py`（N10）—— 不可逆操作的「预览 + 审批」：`preview.py` 用 N9 的 `AssetRef` 描述一次改动（动作/摘要/可逆性/补偿方式/被触及文件的指纹），是**纯函数**；`approval.py` 让 `params.require_approval=true` 的节点在**执行前**挂起为 HumanTask（`kind=approval`，复用 `interrupt()`），批准后按**冻结的预览快照**复验目标指纹，不匹配即拒绝执行（`on_reject: fail|skip`）。审批门在 compiler 节点包装层实现，执行器零改动。`conflict.py`（N10b）把同一套指纹机制扩到**节点自己的等待窗口**：`params.detect_conflicts=true` 的节点先快照声明的宿主产物（含内容哈希），等待结束后、改动前复验，变了就拒绝（`WorkflowConflictError`），只覆盖能观测到的宿主路径。
- `compensation.py` / `undo.py` / `undo_service.py`（N10）—— 「补偿/撤销」：`Compensation` 在 `params.rollback_on_failure=true` 时先备份被触及文件、失败即回滚（备份失败则在改动**之前**拒绝执行）；`undo.py` 是纯模型（`UndoRecord`/`plan_undo` 逆序）+ 文件级备份/恢复；`workflow_undo_records` 表记录每次不可逆动作，`undo_service.py` 供 `POST /api/workflows/{id}/runs/{run_id}/undo` 与对话工具 `undo_workflow_run` 复用。驱动原生 undo 优先（`supports_undo` 标志 + `undo` 方法双条件），否则回落文件级备份。
- `../apps/`（`deerflow/apps/`）——本地专业软件接入层（N4/N6/N8/N10b）：`registry.py`（应用注册表，源自 `config.yaml apps:`）、`driver.py`（`AppDriver` 协议）、`session.py`（进程内实例/会话管理 + **N8 资源准入** + **N10b 人机共享准入**，`app:launch` 等共享）、`persistence.py`（实例记录 best-effort 写穿透）、`drivers/{cli,mock}.py`。**运行在宿主**，是「命令必须走 sandbox」的显式例外；实例落库 `persistence/app_instances/`（表 `app_instances`，迁移 `0017`），Gateway `GET /api/apps`+`/api/apps/sessions*`（列表/详情/close/release/archive/delete/cleanup）+ `GET /api/apps/resources`（N8 配额/占用/排队/License）+ `GET /api/apps/{name}/presence`（N10b 人在用）暴露并管理实例。N8 资源治理：`deerflow/resources/governor.py`（声明式 GPU/CPU/内存/磁盘配额 + License slots，`wait|fail|degrade`）+ `deerflow/locks/file_lock.py`（可重入跨进程文件锁），进程内单实例契约。N10b 人机共享：`apps/presence.py`（纯决策表 `decide_access`，`unknown` 一律放行并标记）+ 驱动可选 `probe_presence`（`cli` 按定义声明的 `presence_command` 探测，`mock` 读 marker 文件），策略 `apps.on_human_conflict: fail|wait|preempt`（`preempt` 需定义声明 `allow_preempt`）。
- `../assets/`（`deerflow/assets/`）——文件/资产与跨软件数据契约（N9）：`ref.py`（`AssetRef` + `asset://` URI + 指纹 + 契约校验）、`contracts.py`（`AssetContract`/`AssetConverter`）。资产经 `data` 端口流转（不新增 PortType）；宿主↔沙箱往返受 `config.yaml assets.roots` 白名单约束（默认空 = 禁用），`convert` 命令走 sandbox。
- `../environment/`（`deerflow/environment/`）——环境探测与数据目录规范（N11，§22 前两条）：`spec.py`（`RequirementSpec`：`executable`/`version`/`path`/`runtime`/`plugin` + 三态结果 `ok`/`missing`/`mismatch` + `unknown`）、`version.py`（版本比较纯函数，不可解析一律 `unknown`）、`evaluate.py`（探测决定表，纯）、`probe.py`（唯一 I/O；**只读**，永不抛）、`requirements.py`（绑定 app `requires` 与 SKILL.md `requires:`，仅 enabled 技能）、`report.py`（与数据目录状态合成）、`__main__.py`（`python -m deerflow.environment`，退出码可进 CI）。加载时校验，默认 fail-open（`apps.environment.require_on_load: true` 才是硬门）；`config.yaml apps.environment` + `AppDefinition.requires` + 已接上的 `version_command`；数据目录布局由 `config/paths.py::data_dirs()/check_data_dirs()/ensure_data_dirs()` 承载（definitions/checkpoints/app sessions 在 SQL 库里，assets 在 `assets.roots`）；`GET /api/environment` 只读报告。**无迁移、无新表**。
- `../portability/`（`deerflow/portability/`）——备份 / 导出导入 / 换机迁移（N11b，§22 第三条）：`spec.py`（归档模型 `BackupManifest` + `check_import_compatible`，纯）、`select.py`（`plan_backup`/`plan_restore` 纯决策：从 `data_dirs()` 选成员、排除 `locks`/`retrieval`）、`archive.py`（安全 zip 读写，拒绝绝对路径/`..`/符号链接条目）、`snapshot.py`（SQLite `Connection.backup()` 一致性快照）、`service.py`（export/inspect/import 编排）、`__main__.py`（`python -m deerflow.portability export|inspect|import`，退出码 0/1/2）。归档 = 单文件 zip + 根 `manifest.json`，逻辑布局 `dirs/<name>/`+`database/<file>`+`assets/<idx>/`（跨机可移植）；导出可对活实例运行（库走在线快照），**导入是离线操作**（覆盖库文件，需先停 Gateway）。`GET /api/backup` 只读返回导出计划。**无迁移、无新表、无新配置段**。
- `context_policy.py`（N14 §24.3）— 节点级上下文工程：纯函数 `estimate_tokens`（CJK-aware 字符估算，离线无依赖、标注为**估算**而非精确）、`parse_context_policy`（规范化 `params.context_policy` = `examples` few-shot / `include` 按名挂载输入端口 / `budget.total_tokens`）、`apply_context_budget`（固定顺序 `identity→capability→task→examples→context→schema`；预算只约束可截断桶 `examples`/`context`，按 `examples` 优先贪婪填装、`context` 先被丢弃/截断；骨架超预算记 `over_budget` **不截断**）。保留结果键 `__context_usage` 由 compiler 提升到 `wf:<node>:__context_usage`。
- `sanitize.py`（N14 §24.12）— 注入防御助手：`neutralize_untrusted(text)` 复用输入净化中间件的 `neutralize_untrusted_tags`（**单一 denylist 来源**，延迟导入避免重/循环依赖），把 AI 节点自行拉入提示词的未信任内容（检索块 §24.2 / 记忆块 §24.1）中的框架权威标签（`<system-reminder>`/`<memory>`/`<context>` 等）中和，使其**无法伪造框架块**。`knowledge.format_retrieval_block` 与 `memory.format_memory_block` 的正文经此处理（外围 `<context>`/`<memory>` 包裹仍是引擎自己的）。失败降级为原文（纵深防御，非硬边界）。
- `patterns.py`（N14 §24.6a/§24.6b）— 多智能体拓扑模板（纯 builder，返回可序列化 `WorkflowDefinition`）：`critic_review_loop`（producer↔critic 有界评审回环，用 `flow:loop` + `params.continue_on` 读 critic 的 `needs_revision` 判定 + `iterations` 硬上限表达，无新引擎行为）、`supervisor_topology`（supervisor `ai` 节点写 `decision` → `flow:switch` 运行期分派到已注册专家节点）；`TEMPLATES` 命名表 + `build_template(name)`（带占位 instruction 的骨架）+ `template_catalog()`；`GET /api/workflows/templates` 暴露给画布插入。纯函数、离线可测。
- `handoff.py`（N14 §24.6a 受控动态 handoff）— supervisor 在**运行期**从**已注册专家节点**中选一个：`flow:handoff` 节点的 `params.candidates = [{value, node}, ...]` 是白名单（`node` 必须存在于同一定义），`params.max_handoffs`（默认 8，1..50）是**本节点每 run** 的交接预算；`decision` 输入承载 supervisor 的选择，`target` 输出承载解析结果，**其余已声明输入原样转发到同名输出**（这就是 handoff 的结构化消息：task / constraints / context 引用）。纯逻辑 `parse_handoff`（坏形状 `HandoffError`，fail-loud：白名单少一条会静默改路由 → 一律不猜）/ `resolve_handoff_target`（未注册选择**报错**并列出允许值）/ `handoff_count_key`。**与 `flow:switch` 的两处刻意差别**：路由边由 **params 生成**（不画边；画了即编译期报错，防两个真相源）、**没有 default 边**（未命中/未设置 → `WorkflowRouteError`；「收工」用 handoff **之前**的 `flow:if` 显式表达）。预算计数走保留通道 `wf:<node>:__handoffs`（引擎记账，不进节点事件输出）。
- `memory_backends.py`（N14 §24.1）— DeerMem 适配器：`MemoryManagerStore(manager, user_id, agent_name, thread_id)` 实现 `MemoryStore` 协议——`search` 把 manager 排序后的 facts 映射为 `MemoryRecord`（仅当后端 `supports_search`），`put` 经 manager 的正常提取管线（`add_nowait` + `HumanMessage`）排队。**诚实作用域映射**：DeerMem 是长期用户/agent 记忆，故仅服务 `long_term`；`session`/`node`/`workflow` 非其模型，返回空/不做（需要者自行实现协议）。部署方将其注入 `runtime.context["memory_store"]`。
- `knowledge.py`（N14 §24.2）— 本地知识检索（纯逻辑 + 参考 store）：`chunk_text`（确定性重叠分块）、`tokenize`（ASCII + CJK 逐字）、`rank_chunks`（BM25-lite 确定性排序 `(-score, citation)` + top_k + 可注入 `reranker`）、`Document`/`Chunk`/`RetrievalRecord`（稳定 `cite:<chunk_id>` 引用）、`KnowledgeStore` 协议（`upsert`/`query`，支持异步）+ `InMemoryKnowledgeStore` + `ingest_document`、`parse_retrieval_params`（`params.retrieval = {collection, query?, top_k?, ctx_budget?, rerank?}`）、`format_retrieval_block`（`<context>` 块 + `--- cite ... ---` 头，按 `estimate_tokens` 预算）、`aquery`。`ai:llm_agent` 从 `runtime.context["knowledge_store"]` 检索并前置 `<context>` 块，失败仅告警；与 continue 互斥。embedding/向量后端为可插拔 store；专用 `data:knowledge` 节点列为后续增量。
- `memory.py`（N14 §24.1）— 节点级记忆：纯逻辑 `parse_memory_policy`（`params.memory = {scopes: session|node|workflow|long_term, query?, inject_budget?, write?, write_scope?}`，坏形状 `MemoryPolicyError`）、`render_query`（`{{port}}` 插值）、`format_memory_block`（`<memory>` 块，按 `estimate_tokens` 预算顺序丢弃）、`MemoryStore` 协议（`search`/`put`）+ `InMemoryMemoryStore` 参考实现 + `collect_memory`/`acollect_memory`/`awrite_memory`（支持异步 store）。`ai:llm_agent` 从 `runtime.context["memory_store"]` 取 store：读命中拼进提示词、`write` 时把节点输出写回；**读写失败仅告警不阻塞节点**（§24.1）；与 continue 模式互斥。生产接入 DeerMem（`memory_store` 适配器）为后续增量。
- `routing.py`（N14 §24.10）— 节点级模型路由（本地/隐私优先）：纯函数 `parse_routing_policy`（`params.model_policy = {prefer: default|local|cheap|quality, require_local}`）、`model_infos(models)`（从 `config.models[*]` 读可选 `local`/`cost_tier`，extra-allowed）、`select_model`（确定性选择 + 名称稳定 tie-break；`require_local=True` 无本机模型 → `RoutingError`，**绝不静默回退远程**）。`ai:llm_agent` 据 policy 选择模型名写入 `SubagentConfig.model`（continue 模式拒绝 policy）。无新配置段（模型元数据走 `models[*]` 额外字段）。
- `definition_evals.py`（N14 §24.8）— 定义**内嵌**评测套件：`metadata.evals = {fixture: ReplayFixture, cases: [...], require_pass?, on_miss?: error|live, initial_state?}` 经 `parse_definition_evals`（坏形状 `DefinitionEvalError`，**fail-loud**——非法规格绝不静默关掉门）→ `evaluate_definition_evals`（复用 N14p runner：replay 夹具离线回放，无真实模型/工具调用）→ `eval_gate_errors`（逐条断言失败文案）。**保存门 opt-in**：仅 `require_pass: true` 的定义在创建/更新时被拦（失败 422），仅「记录期望」的套件永不阻塞保存。`definition_has_evals` 供路由判断。纯逻辑 + 一处 harness 内 runner 调用。§24.8 的**能力包侧**是 `skills/eval_gate.py`（导入/升级时校验包自带 `evals/*.json`，同为 opt-in），见 [backend/AGENTS.md](backend/AGENTS.md)。
- `eval_cli.py`（N14 §24.8）— 评测 CLI：`python -m deerflow.workflow.eval_cli --definition d.json --fixture f.json --cases c.json [--on-miss error|live] [--json]` 加载定义/夹具/用例，回放执行后报告；退出码 `0`（全过）/`1`（有失败）/`2`（输入加载或运行失败），可进 CI。
- `eval_runner.py`（N14 §24.8）— 评测 runner：`evaluate_replayed_run(definition, fixture, cases, ...)` 编译定义并以 **replay 模式**对 golden fixture 执行（无真实模型/工具调用），抽取节点输出后逐 case 断言 → `EvalReport`；未录制节点默认 fail-loud（`on_miss=error`），`live` 可选回退。可传 `judge`（语义断言）与自定义 `compile_context`。
- `evals.py`（N14 §24.8）— 评测/回归断言核心（纯逻辑，离线可测）：`extract_node_outputs(state)` 把最终状态的 `wf:<node>:<port>` 通道按节点分组（跳过 `wf:shared:` 与 `__` 保留通道）、`NodeAssertion`（`equals`/`contains`/`matches`/`exists`/`truthy`/`semantic`；semantic 需 `judge(expected, actual)->bool` 注入式判定，缺省注记通过/失败）、`evaluate_assertion`/`evaluate_case`、`EvalReport`（通过数/率/失败）+ `to_dict/to_json`、`run_eval_suite`。确定性端口用精确断言，AI 端口用语义断言（LLM-as-judge/相似度由调用方注入）。消费 N14 §24.11 回放 run 的最终状态。
- `replay.py`（N14 §24.11）— 确定性 record/replay：节点输出粒度录制——`input_digest(node_id, node_type, inputs)`（规范化 JSON → sha256，确定性）、`ReplayEntry`/`ReplayFixture`（JSON 往返 + `save_fixture`/`load_fixture` 原子写）、`ReplaySession(mode=record|replay, on_miss=error|live)`（`record` 追加条目、`replay` 命中回放输出/未命中按 `on_miss` 报错或回退真实执行）、`redact_secrets`（递归掩码 `*key*/*token*/*secret*/*password*/*credential*` 等）。compiler `_make_node_fn` 读运行上下文键 `REPLAY_CONTEXT_KEY`：replay 命中即**跳过 executor**（无真实模型/工具调用），record 模式在 executor（含重试）成功后落条目；无 session 零行为变化。**无迁移/无新表/无新配置/无新依赖**。
- `budgets.py`（N14 §24.10）— 运行级预算强制：纯函数 `parse_run_budget`（`metadata.budget = {max_total_tokens, on_exceed: warn|abort}`，坏形状 `BudgetError`）、`usage_total`/`aggregate_token_usage`（聚合各节点 `wf:<node>:__token_usage`）、`evaluate_budget`。compiler 的 `_validate_run_budget` 编译期校验、`_make_node_fn` 每节点后聚合 state（含本节点用量）并按策略 `warn`（日志继续）/`abort`（节点失败停止 run）——`degrade` 刻意不设（token 已花，无法退回）。节点级 token 上限仍由 §24.5 `params.autonomy` 承担。
- `embeddings.py`（N14 §24.2 向量后端）— **可插拔 embedding store**：`VectorKnowledgeStore` 实现与 `InMemoryKnowledgeStore` 相同的 `KnowledgeStore` 协议（`upsert`/`query`），按**余弦相似度**排序；embedder **注入式**（`Embedder` 协议 + `embeddings_from_callable(fn)` / `embeddings_from_langchain(embeddings)` 适配器，**不引新依赖**）。`normalize_vector`/`cosine_similarity` 为纯函数；`upsert` 按 chunk id **幂等替换**、已有 `embedding` 的 chunk 不再重复嵌入且**不改调用方对象**；`query` 排序 `(-score, citation)` 与关键词路径同约定、非空 query 丢弃非正分、reranker 注入且异常不破坏检索。**fail-loud**：embedder 返回数量不符/非数值/参差/零宽向量、或查询与索引**维度不一致**一律 `EmbeddingError`（静默空结果会让检索 bug 伪装成「无命中」）。部署方把它注入 `runtime.context["knowledge_store"]` 即可替换关键词检索。无迁移/无新表/无新配置段/无新依赖。
- `breakpoint.py`（§25 调试）— 节点断点：`params.breakpoint = true` 让节点**执行前**挂起，复用 N10 审批门的 HITL 机制——同一个 HumanTask 行（既有 submit/skip 工具与 `/api/human-tasks` 路由零改动）、同一个 `interrupt()` 与 `(run_id, node_id)` 行复用规则、同一个 `{"__skip": True}` 哨兵（`skip` 即跳过该节点输出）。**刻意没有** preview 与指纹复验（断点不批准任何东西、挂起前无副作用）。任务含**一个必填 bool 端口** `acknowledge`（`enum: [True]`）——LangGraph 把**假值** `Command(resume=...)` 当作「未 resume」会再次挂起，空提交会把 run 卡死，故必须非空；`BreakpointDecision.from_resume` 除哨兵外一律继续。编译期 `_validate_breakpoints` 拒绝非 bool 与 `flow:start`/`flow:end`（永不执行，静默忽略是这里最坏的失败形状）。**单步（step mode）**：run 级开关 `debug_step`（`WorkflowRunRequest.debug_step` → `start_workflow_run` → worker 注入 `config["context"]["debug_step"]`）让**每个**节点执行前挂起（`kind=step` 的同一 HumanTask 家族）；**resume 时按任务行 `inputs_snapshot.kind` 重新推导**该标志（app 的 `_resume_workflow` 与 harness 的 `dispatch.resume_workflow_run` 都读同一条记录），所以单步会一次一个节点地推进；节点自身 `breakpoint` 与 step 同时命中时**只挂起一次**（一次访问一次暂停）。
- 节点级耗时观测（N14x）：compiler 的节点包装在**执行段**（仅 executor 调用，含 `params.retry` 重试与退避；**不含**审批/人工等待）计时并写保留通道 `wf:<node>:__duration_ms`（每个节点类型都声明该通道）；**replay 命中不写**（未做实事，写 ~0ms 会伪装成真实执行）。worker 在 `run.end` content 增 `node_timings = {nodes: {...}, total_ms, slowest_node}`（additive，无通道即不写；`slowest_node` tie-break 按 node id 稳定）；`get_workflow_run` 以 additive `node_timings` 暴露。**节点事件 `output` 只含声明端口**——`__` 保留通道（`__token_usage`/`__duration_ms`/`__retry` 等）是引擎内部记账，经 run.end 聚合对外，不进 `wf:node:completed` 事件。
- `costs.py`（N14 §24.10）— 运行成本报表（**纯逻辑**）：`build_pricing_map(models)`（读 `models[*].pricing` 的 `currency`/`input_per_million`/`output_per_million`/`input_cache_hit_per_million`，与 console 计价**同一约定**；无价或**混合币种**一律返回 `{}` = 关闭计价）、`node_usage_from_state(state)`（抽取 `wf:<node>:__token_usage` 保留通道）、`token_cost`（**cache-aware**：缓存命中按命中价、其余按未命中价，命中数钳到 `[0, input]`）、`build_run_cost_report(state, models, default_model=...)`。**诚实归因**：用量通道只记 token 不记模型，故按 `default_model` 计价并在每个节点回报所用模型（与 console 对无 per-model 拆分行情的既有回退一致）；未定价模型 `cost: null`（不伪造 0），全未定价则 `total_cost: null`。`GET /api/workflows/{id}/runs/{rid}/cost` 暴露。无迁移/无新表/无新配置段/无新依赖。
- `reliability.py`（N14 §24.7）— 工作流可靠性地基：纯函数 `parse_retry_policy`（`params.retry = {max_attempts 1..10, backoff_seconds 0..60, retry_on?}`，坏形状 `RetryPolicyError`）、`is_retryable_exception`（**控制流/取消永不重试**：`GraphBubbleUp`/`BaseException` 子类排除）、`should_retry`、`idempotency_key(run_id, node_id)`（**稳定键**，不含 attempt——重试复用同键才能被外部去重）、`resolve_idempotency_key`。compiler 在**仅幂等节点**上以 `params.retry` 包裹 executor 调用（`_validate_retry` 编译期拒绝非幂等 `params.retry`），重试次数写保留通道 `wf:<node>:__retry`；`params.idempotency`（true/字符串）经 `__idempotency_key` 注入 executor，`tool:http` 发 `Idempotency-Key` 头、`tool:bash` 注入 `DEERFLOW_IDEMPOTENCY_KEY` 环境变量。effect journal 复用既有 `workflow_undo_records`（N10），AI 诊断式自愈为后续增量。
- `prompts.py` — 三层提示词组装器：身份层（custom agent SOUL）→ 能力层（功能组工具描述 + rules + allowed-tools 并集）→ 任务层（节点 instruction 模板，支持 `{{port}}` 插值）；N14 §24.3 增 `build_examples_layer`（声明式 few-shot `<examples>`）/`build_context_layer`（按名挂载输入端口 `<context>`）/`build_ai_node_buckets`（固定桶顺序的单一来源）。纯函数。
- `../capability_groups/` — 能力组（不是 skill）的版本化发现层：能力组是 `capability-groups/<name>/<version>/group.json` 的顶层能力包，可包含 rules / agents / skills / tools / references / templates / assets / evals；skill 只是其中一种子资源。`discovery.py` 按 GUID/版本扫描 public 与 per-user 根目录，`contents.py` 分类并生成 Markdown 单行摘要（内置分类固定顺序；任意其它顶层目录名保留为该分类，分类内目录层级由管理页以文件夹树展示），`reveal.py` 在宿主文件管理器中定位文件或能力组根目录。`GET /api/capability-groups`、`GET /api/capability-groups/{guid}`、`POST /api/capability-groups/{guid}/reveal` 暴露管理页所需数据。`ai:capability_group` 选择节点已按新语义重写：`params.groups` 保存能力组 GUID/名称，编译期解析后注入 AI 节点并从可执行图剥离；旧的 skill-as-group 解析与 `ai:capability_merge` 节点已删除。
- `prompt_preview.py` — 静态 Prompt 预览：`build_prompt_preview` 用同一套 bucket 组装器生成 system + task，未提供的 `{{port}}` 保留占位符，memory/retrieval 明确列为 runtime omitted；`POST /api/workflows/{id}/prompt-preview` 接受当前（可未保存）画布 definition。AI 节点执行时把完整文本写入保留通道 `wf:<node>:__prompt`，`ai:prompt_preview` 节点读取该通道展示运行后的真实 prompt。
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
