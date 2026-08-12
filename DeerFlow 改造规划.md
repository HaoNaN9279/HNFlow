# 基于 DeerFlow 的 HNFlow 改造规划

> 分支：`deerflow-rebase`（root commit `af5f6bb` = HNFlow 规划文档；`a7737a5` = DeerFlow 2.0 源码基准，源 HEAD `88252e9b`）

## 一、结论

HNFlow 是「图驱动的确定性编排引擎」，DeerFlow 是「对话驱动的 super agent harness」。两者互补。

改造姿势：**在 DeerFlow 现有 harness 之上叠加一层「工作流图定义/编译层」，把 DeerFlow 全部现有能力（Skills、MCP、Sandbox、Checkpointer、Interrupt、Subagent）降为节点的执行底座。** 不推倒重来。

DeerFlow 净缺三样：**流程定义 DSL、端口数据流绑定、可持久化嵌套子图**。其余全部白捡。

**已确认的四项决策**：
1. **形态**：Web 服务 + 本地部署（docker compose 或裸机），**不保留桌面端**；数据主权仍在本机。
2. **后端语言**：Python（沿用 DeerFlow），放弃 HNFlow「内核纯 TS」约束。
3. **画布**：React Flow（复用 `ai-elements/` 已有组件），不引入 X6。
4. **执行模型**：确定性与自主性并存——流程型任务走工作流图，自由任务走现有对话；goal loop / plan mode 作为「图中的一个 AI 节点」保留。

## 二、现状对比

| 维度 | HNFlow（目标） | DeerFlow（已有） | 差距 |
|---|---|---|---|
| 运行时 | Web 服务 + 本地部署（决策①） | Python FastAPI Gateway + Web | 一致（沿用 DeerFlow 形态） |
| 图引擎 | React Flow（编辑器，决策③） | LangGraph（执行）+ React Flow 组件（`frontend/src/components/ai-elements/`，未接线） | 执行复用，编辑器接线 React Flow |
| 执行引擎 | 自建状态机 | LangGraph 全量：checkpointer(sqlite/pg)、DeltaChannel、checkpoint 回滚、`Command(resume=...)` 中断续跑 | 直接复用 |
| 能力模块化 | 功能组：GUID+semver+不可变版本+依赖解析+懒加载 | Skills：public/custom、`.skill` 安装、安全扫描、allowed-tools 策略；frontmatter 有 `version`/`compatibility` 死字段 | 半成品，补版本/依赖/GUID |
| 自定义节点 | 打包子图为复合节点 | 无节点概念；tools 用 `module:variable` 反射注册（`tools/tools.py`） | 需新建节点 DSL + 编译层 |
| 嵌套工作流 | 无限层级 + 循环检测 | task_tool 子代理委派（禁递归、无 checkpointer） | 放开策略 + 子代理持久化 |
| 人工节点 | 一等公民 HumanTask | `ask_clarification` + interrupt/`Command(resume=...)`（`services.py:1131`） | 统一为 HumanTask |
| MCP | 进程池管理 | stdio/http/sse、OAuth、session pool、routing hints、tool_search 懒加载 | 白捡 |
| 断点续跑 | 每步持久化 | LangGraph checkpoint 原生 + goal loop（≤8 次自动续跑） | 白捡 |
| 双入口 | 可视化+AI 对话 | AI 对话即主界面（lead agent + SSE + 监控） | 白捡对话侧 |
| 调度 | — | scheduler（cron/once，有 lease） | 白捡 |
| 多租户 | 本地部署（沿用 DeerFlow 用户隔离） | user_id 隔离、user-scoped storage 模式成熟 | 直接套用 |

## 三、目标架构（六层映射到 DeerFlow 现有结构）

```
┌─────────────────────────────────────────────────────────────┐
│ 用户交互层（已有：Next.js）                                   │
│   ├── 对话界面（复用现有 chat UI + SSE）        ← 白捡        │
│   └── ★ 工作流画布（接线 ai-elements/ 的 React Flow 组件，     │
│         不引入 X6，避免前端双图栈）                           │
├─────────────────────────────────────────────────────────────┤
│ 工作流定义层 ★新建（backend/packages/harness/deerflow/workflow/）│
│   ├── schema.py      节点/边/端口类型定义（Pydantic）          │
│   ├── workflow_io.py WorkflowDefinition JSON 序列化/校验       │
│   └── registry.py    自定义节点注册表（打包子图→复合节点）      │
├─────────────────────────────────────────────────────────────┤
│ ★ 编译层 ★新建                                               │
│   └── compiler.py    WorkflowDefinition → LangGraph StateGraph │
│       节点→图节点；边→条件边/普通边；端口→state 字段            │
├─────────────────────────────────────────────────────────────┤
│ 执行引擎层（复用 runtime/，仅加薄封装）                        │
│   ├── workflow_worker.py  编排 run_agent/checkpointer/interrupt│
│   ├── human_task.py       统一挂起（复用 Command resume）       │
│   └── subgraph.py         子工作流→子图/递归 task_tool          │
├─────────────────────────────────────────────────────────────┤
│ 能力层（全部已有，改造 Skills 即得功能组）                     │
│   ├── skills/ → capability_groups/（+GUID+semver+依赖）       │
│   ├── mcp/（不动） sandbox/（不动） subagents/（放开+持久化）   │
│   └── extensions/（不动，middleware 注入保持）                 │
├─────────────────────────────────────────────────────────────┤
│ 基础设施层（复用）                                            │
│   ├── persistence/（+workflow_definition、group 表）          │
│   ├── runtime/events/store（复用 JSONL/DB 事件流）             │
│   └── user-scoped storage 模式（复用，工作流定义按 user 隔离） │
└─────────────────────────────────────────────────────────────┘
```

**核心理念：WorkflowDefinition 是纯 JSON（可序列化），编译后变成 LangGraph StateGraph（可执行）。可序列化由定义层保证，可执行/断点/挂起全部白捡 LangGraph。**

## 四、三大核心功能改造

### 4.1 模块化能力系统（Skills → CapabilityGroups）

1. **版本化**：启用 `SKILL.md` frontmatter 死字段 `version`/`compatibility`，存储改为「版本目录不可变」（`<name>/v1.0.0/SKILL.md` 写时复制）。
2. **GUID 不变性**：安装时生成 GUID，改名写 aliases；`_skill_states.json`/`extensions_config.json` 加 guid 映射。
3. **依赖解析**：frontmatter 加 `dependencies: [{guid, versionRange}]`，保存时静态校验 + 循环检测（扩展 `catalog.py`）。
4. **命名空间工具前缀**：推广 MCP 的 `<server>_` 前缀机制（`tool_name_prefix`）到所有 skill 工具。
5. **懒加载**：复用现有 SkillActivationMiddleware + deferred tool_search（DeerFlow 已实现）。

### 4.2 可序列化的自定义节点

- **定义层**：`Node` = {id, type, inputs: Port[], outputs: Port[], params, capabilityGroups[]}，Pydantic 可序列化，与 HNFlow `CustomNode` 一一对应。
- **节点实现**：扩展 `module:variable` 反射注册模式——节点执行函数 = 接收 `runtime: Runtime` + 端口输入，返回端口输出；原子节点复用现有 builtin tools。
- **复合节点**：定义层存 `subgraph: WorkflowDefinition`，编译层展开——LangGraph 原生支持嵌套 StateGraph 作为节点，嵌套执行/错误传播/checkpoint 自动获得。
- **注册**：复用 `extensions/` 的 ExtensionRegistry 模式（middleware/task_lifecycle → 增加 node 一类），`required:true` 失败即停、部分失败回滚照搬。

### 4.3 可嵌套的工作流

| 嵌套方式 | 实现 | 复用点 |
|---|---|---|
| 编译期子图 | definition 引用另一 definition，compiler 内联展开为子 StateGraph | LangGraph 嵌套图 + checkpointer |
| 运行期委派 | 工作流节点 = 增强版 task_tool，委派给子工作流 | `subagents/executor.py` + 放开 `disallowed_tools=["task"]` + 子代理开 `checkpointer=True`（现为 False） |

- **循环依赖检测**：定义层保存时对全局 definition 依赖图做 DFS。
- **断点续跑**：LangGraph checkpoint 覆盖整图（含子图）——「循环状态持久化、精确跳转」免费获得。
- **人工节点**：`interrupt()` → 统一转 HumanTask（persistence 加表），`Command(resume=...)` 恢复。

## 五、AI 节点提示词设计

不是单一作者，是**三层拼装**：

```
┌ 身份层：功能组 agent.md / SOUL ── 功能组作者写（一次，复用所有节点）
├ 能力层：rules / skills / 工具描述 ── 功能组作者写（同上）
└ 任务层：节点 instruction 模板 ── 工作流作者在画布上写（每节点一份）
```

运行时按「身份 → 能力 → 任务」拼成 system+user prompt 喂 `create_agent`。工作流作者只写任务层。

**两档任务层模式**：
1. **模板模式（默认，保确定性）**：节点参数写指令模板，支持上游端口数据插值（`{{url_list}}`）。模板必填，留空保存时校验报错。
2. **委托模式（可选，上游生成）**：模板引用上游 AI 节点输出作为任务指令（规划→执行分工），复用 `task_tool(prompt=...)` 语义。

**关键约束**：
- AI 节点 ≠ 自由 ReAct loop：节点内只能调用关联功能组声明的工具（allowed-tools 策略现成），LLM 只决策「调用哪个工具、按模板产出什么」。
- 工具调用中间消息（assistant 推理、tool result）是模型自生成，不属于提示词编写范围。

**复用机制**：custom agent 机制（config.yaml + SOUL.md，`agents/lead_agent/`）；slash activation 等价物（节点执行时激活关联功能组）；`create_deerflow_agent` middleware 链原样作用于节点执行上下文。

## 六、改造任务拆解（T1–T18）

> 每个任务 = 一次 Prometheus 规划 + Atlas 执行的标准任务量（1 计划 + 若干步骤 + 独立验证）。
> 依赖约定：`T3←T2` 表示 T3 依赖 T2 完成。无依赖标注的任务可并行。

### 任务总览

| 任务 | 内容 | 依赖 | 所属阶段 |
|---|---|---|---|
| T1 | workflow 包骨架 + 数据模型 | — | A 定义层地基 |
| T2 | 定义校验器 + JSON 序列化 | T1 | A |
| T3 | definition 持久化 CRUD + REST API | T2 | A |
| T4 | compiler v1：串行/条件 DAG → StateGraph | T2 | B 执行引擎 |
| T5 | 原子节点执行器（复用 builtin tools） | T4 | B |
| T6 | 执行接线：worker + checkpoint + run events + SSE | T4, T5 | B |
| T7 | Skills 版本化存储（semver + 不可变版本目录） | — | C 能力层 |
| T8 | 功能组 GUID + 命名空间前缀 + 依赖解析 | T7 | C |
| T9 | 编译期子图展开（嵌套 StateGraph） | T4, T7 | D 嵌套 |
| T10 | 运行期委派：子代理 checkpointer + 放开 task 递归 | T4 | D |
| T11 | 全局依赖图循环检测 | T8 | D |
| T12 | HumanTask 数据模型 + 持久化 | — | E 人工与挂起 |
| T13 | 统一挂起：interrupt 对接 HumanTask + 恢复链路 | T12, T6 | E |
| T14 | React Flow 画布接线 + node/edge CRUD | T3 | F 画布 |
| T15 | 子工作流节点渲染 + 节点表单面板 | T14 | F |
| T16 | 运行监控/调试面板 | T6, T14 | F |
| T17 | lead agent 工作流工具（生成/编辑/校验） | T8, T14 | G 对话侧 |
| T18 | 对话调度/进度汇报/异常修复 | T6, T17 | G |

---

### 阶段 A：定义层地基

#### T1 workflow 包骨架 + 数据模型

**内容**
1. 新建 `backend/packages/harness/deerflow/workflow/` 包（含 `__init__.py` 导出公共 API）
2. 定义 Pydantic 模型：`Port`（name/type/data|file|bool|enum/required）、`Node`（id/type/inputs/outputs/params/capabilityGroups）、`Edge`（source/sourcePort/target/targetPort/condition?）、`WorkflowDefinition`（id/name/version/nodes/edges/metadata）
3. 定义节点类型枚举：`flow`（start/end/if/switch/loop/parallel/wait）、`data`（assign/convert/file/json/regEx）、`tool`（bash/http/notify/log）、`ai`（llm_agent）、`human`（human_task）、`nested`（subworkflow）
4. 建立 `metadata.resolvedGroups` 字段占位（功能组依赖快照，T8 填充）

**注意点**
- 模型必须严格 Pydantic v2 风格，禁止宽松 dict；`id` 校验为稳定标识（uuid 或 slug），禁止路径字符（`/`、`\`、`..`），后续落盘安全依赖此约束
- `Port.type` 用枚举而非字符串自由值，为端口连线类型校验打基础（T2 校验）
- 不引入 LangGraph 依赖到数据模型层——定义层与执行层解耦，保证纯 JSON 可序列化
- 参考 `skills/types.py` 的模块风格，保持 harness 包内命名一致

**验证点**
- [ ] `WorkflowDefinition` 可无参构造、可深拷贝、`model_dump()`/`model_validate()` 往返无损
- [ ] 非法 id（含路径字符/超长）构造报 `ValidationError`
- [ ] 新增 3 个以上单测覆盖模型边界（`backend/tests/` 下，遵循仓库 TDD 约定）

#### T2 定义校验器 + JSON 序列化（workflow_io.py）

**内容**
1. `validate_definition(def)`：图结构校验——无环（DFS）、单起点单终点、端口连线类型匹配（port type 兼容）、目标节点端口存在、参数类型合法
2. `serialize(def)` / `deserialize(text)`：JSON 编解码，含 schema version 字段与向后兼容迁移钩子
3. 循环依赖检测基础版（节点边层面 DAG 环），报错携带完整环路路径

**注意点**
- 无环检测用迭代 DFS（栈），不用递归——HNFlow 规划明确要求避免大图栈溢出；环错误要输出完整路径 `A→B→C→A`
- 端口类型匹配规则集中在单一纯函数，供前端画布（T14）复用做实时连线校验——后端先定标准，前端照抄
- schema version 从 1 起步，迁移钩子预留空实现，别过度设计
- 校验器保持纯函数（无 IO），方便单测与前端复用

**验证点**
- [ ] 环图校验失败且报错含完整环路路径
- [ ] 端口类型不匹配（string 连 file）被拒绝
- [ ] 序列化→反序列化→再序列化幂等（golden test）
- [ ] 单测覆盖：合法 DAG 通过、缺起点/多终点拒绝

#### T3 definition 持久化 CRUD + REST API

**内容**
1. persistence 新增表 `workflow_definitions`（id/user_id/name/schema_version/definition JSON/metadata/resolved_at），复用 `persistence/` SQLAlchemy async 模式
2. user-scoped 存储层：仿照 `skills/storage/user_scoped_skill_storage.py`，按 user_id 隔离文件/DB 访问
3. Gateway 新增 REST 路由 `workflow_routes.py`：`GET/POST /api/workflows`、`GET/PUT/DELETE /api/workflows/{id}`，保存时自动调 T2 校验器
4. 对外暴露 LangGraph 兼容风格 API 占位（`/api/langgraph/workflows/...` 后续由 nginx 重写复用）

**注意点**
- 保存流程：先校验再落盘（原子写入，复用 `skills/storage/local_skill_storage.py` 的 tmp+replace 模式）；校验失败返回 422 与具体节点路径
- user_id 解析复用现有鉴权链路（`get_effective_user_id`），无 auth 模式 fallback `default`——与现有多租户行为一致
- 不急着做版本化（T7 后才有功能组版本），本任务 definition 本身先支持 `version` 字段存储但不展开历史
- ORM 模型在 `persistence/models.py` 集中注册，别散落

**验证点**
- [ ] API 层单测：创建/读取/更新/删除工作流定义全链路（含鉴权与 422 校验失败）
- [ ] 两个 user_id 下同名工作流互不可见
- [ ] 落盘文件原子性：模拟写中断后原文件完好

---

### 阶段 B：执行引擎

#### T4 compiler v1：串行/条件 DAG → StateGraph

**内容**
1. `compiler.py`：`compile_definition(def, context) -> CompiledStateGraph`，节点映射为 LangGraph 节点函数，边映射为普通边/条件边
2. 端口→state 字段绑定：节点输入端口读 state，输出端口写 state（命名 `wf:<node_id>:<port>`），与节点内部执行函数解耦
3. 支持 start/end/if（条件边）/串行基础调度；loop/parallel 留接口（T5/T9 补）
4. 编译产物注册表：definition 哈希 → 图实例缓存，definition 变更自动失效

**注意点**
- **不要试图在 compiler 里造新调度器**——全部转成 LangGraph 语义（条件边 = `Route` 函数），出错行为（超时/递归限制）沿用 LangGraph 默认
- state 字段冲突：端口字段名必须带 node_id 前缀，避免多节点同名端口互相覆盖；reducer 语义默认「覆盖」，先不做自定义 reducer
- 图缓存必须带 definition 哈希，防热更新后串用旧图（DeerFlow 配置热更新机制同样适用于此）
- 条件边 Route 函数要容错：上游输出缺失时走默认分支而非抛错

**验证点**
- [ ] 单测：3 节点串行图编译执行，端口数据正确流转
- [ ] 单测：if 节点按输入变量选分支（true/false 两路）
- [ ] 编译缓存：同 definition 二次编译返回同一实例，变更后返回新实例
- [ ] LangGraph 可视化（`graph.get_graph().print_ascii()`）与定义拓扑一致

#### T5 原子节点执行器（复用 builtin tools）

**内容**
1. 节点执行器注册表 `registry.py`：`type → executor callable(runtime, params, inputs) -> outputs`
2. 实现流程控制：if/switch/loop/parallel/wait（loop 与 parallel 先实现单层，深层循环持久化 T9 后用 LangGraph 递归或 checkpointer 语义补）
3. 实现数据/工具类原子节点：assign/convert/file/json/regEx/bash/http/log——**直接包装现有 builtin tools**（`tools/builtins/` 的 bash/file 等），不重复造
4. 节点执行函数统一签名：接收 `runtime: Runtime`（复用 `tools/types.py` 的 `ToolRuntime` 模式）获取 sandbox/config/thread 上下文

**注意点**
- 原子节点执行器与 AI 节点执行器（T6 后）分层：本任务只做无 LLM 的确定性子集，AI 节点先注册为「未实现」占位并抛明确错误
- loop/parallel 的语义先做「简单版」：loop 用固定迭代数、parallel 用 `asyncio.gather`，复杂语义（迭代状态持久化、分支上下文隔离）留 T9 与 T16 细化——**不要一次做完，防止任务膨胀**
- bash/command 类节点必须走 sandbox 执行（复用 `sandbox/` 的 `Sandbox.execute_command`），禁止直连宿主 shell——安全边界不能绕过
- 幂等标注：对照 HNFlow v0.9.5 的 registry 审计模式，每个节点显式标注 `idempotent`，非幂等节点（bash/http/mcpTool）留 crashConfirm 钩子

**验证点**
- [ ] 每个原子节点类型有 ≥1 单测：入参→输出断言
- [ ] bash 节点在 sandbox 隔离下执行成功（Docker sandbox 模式）
- [ ] loop 固定迭代 3 次、parallel 两个分支并发完成
- [ ] AI 节点执行时报「未实现」且错误信息可读

#### T6 执行接线：worker + checkpoint + run events + SSE

**内容**
1. `workflow_worker.py`：编排入口——接收 definition id + 输入参数，调 T4 编译，`graph.astream(..., stream_mode=["updates","custom"])` 执行
2. 复用 `runtime/runs/worker.py` 的 run 生命周期：RunRecord、checkpointer（sqlite 持久化）、run events（JSONL/DB）、终端 delivery 回执
3. 挂到 Gateway：`POST /api/workflows/{id}/runs`（或 LangGraph 兼容 runs 路由），SSE 流式推送节点级进度事件（`wf:node:started|completed|failed`）
4. 断点续跑：`graph.ainvoke(None, config={"configurable": {"thread_id": ...}})` 复用现有 checkpointer 恢复机制；提供 `GET /api/workflows/{id}/runs/{rid}/state`

**注意点**
- **不要新写执行循环**——直接调 `graph.astream`，run 事件、断点、取消全部继承 LangGraph/DeerFlow 现有语义；只做「节点级进度映射」薄层
- SSE 事件格式遵循 `contracts/run_event_stream_contract.json` 现有 envelope，新增 `wf:*` 子类型，别另起一套
- checkpoint 的 thread_id 映射：一个工作流实例 = 一个 thread_id，子图/并行分支共享同一 thread 但用不同 `recursion` 命名空间，防止状态串扰
- run 取消/超时复用 `runtime/runs/` 现有取消机制，不重复实现

**验证点**
- [ ] 端到端：POST 运行 5 节点串行工作流，SSE 收到完整节点事件序列，状态正确
- [ ] 中断模拟：kill 进程后重启，从断点恢复执行（checkpoint 单测）
- [ ] 运行事件落盘为 JSONL，格式符合既有 contract
- [ ] 取消运行后状态为 cancelled 且无残留任务

---

### 阶段 C：能力层

#### T7 Skills 版本化存储（semver + 不可变版本目录）

**内容**
1. 存储布局升级：`<root>/public/<name>/v<semver>/SKILL.md`（custom 同理），旧布局（无版本目录）迁移到 `v0.1.0`
2. frontmatter 启用 `version`/`compatibility` 字段解析（`skills/frontmatter.py` 扩展），semver 校验（`semver` 库或自写比较器）
3. 不可变保证：已发布版本目录只读（写操作拒绝），修改 = 创建新版本目录；写路径全部走 tmp+原子替换
4. 加载器兼容：`LocalSkillStorage.read_custom_skill` 等返回「指定版本」内容；未指定版本时返回 current（版本列表最高者）

**注意点**
- **迁移风险最高**：旧布局用户数据必须无损迁移，迁移脚本幂等、失败可回滚（参考 `deermem/core/storage.py` 的 journal 恢复模式）
- 版本目录一旦发布禁止原地修改——这是功能组「版本不可变」的基石，宁可拒绝写入也不静默覆盖
- `projection.py`（sandbox skills 投影）同步支持版本目录布局，否则 skill 视图与磁盘不一致
- frontmatter 解析保持向后兼容：无 version 字段的旧 skill 视为 `v0.1.0`

**验证点**
- [ ] 旧布局 skill 迁移后内容无损，加载器返回正确
- [ ] 发布 v1.0.0 后尝试修改被拒绝，创建 v1.1.0 成功且 v1.0.0 内容不变
- [ ] semver 非法版本（`v1.2`、`1.2.3.4`）校验报错
- [ ] 既有 skills 测试全部通过（无回归）

#### T8 功能组 GUID + 命名空间前缀 + 依赖解析

**内容**
1. GUID 生成与绑定：安装 skill 时生成 guid（或复用现有 id），`group.json`/frontmatter 存 guid + aliases，改名写 aliases 不换 guid
2. 命名空间工具前缀：将 MCP `<server>_` 前缀机制（`tool_name_prefix`）推广到 skill 工具——工具名 = `{group_namespace}.{tool_name}`，`tools/` 加载时统一改写
3. 依赖解析：frontmatter 加 `dependencies: [{guid, versionRange}]`，`catalog.py` 扩展静态校验（存在性 + 版本范围 + 循环检测）
4. `metadata.resolvedGroups` 快照落盘：保存工作流时递归收集节点功能组依赖（`guid@version` 集合）

**注意点**
- 前缀改写发生在工具装配层（`tools/tools.py get_available_tools`），不侵入单个工具实现——保持工具自身无感知
- 依赖循环检测是跨实体（功能组→功能组）的第二层环检测，与 T2 的图环检测分层，别混
- 快照有效期：`resolvedGroups` 需带时间戳，子节点变更后标记过期（HNFlow 快照机制），本任务先实现存储与标记，UI 提示留 T17
- GUID 是最终标识：路径/名称只用于展示与 LLM 语义理解（HNFlow 明确原则）

**验证点**
- [ ] 两个 skill 同名工具加载后自动加前缀，无覆盖冲突
- [ ] 依赖不存在的 guid@version 静态校验报错并提示具体节点路径
- [ ] 功能组 A→B→A 循环被检测并输出完整环
- [ ] 工作流保存后 `resolvedGroups` 正确落盘

---

### 阶段 D：嵌套

#### T9 编译期子图展开（嵌套 StateGraph）

**内容**
1. 定义层支持 `subworkflow` 节点：引用另一 definition（全局模板或内联子图），带参数映射（入参端口→子图输入、子图输出→出参端口）
2. compiler 展开：`subworkflow` 节点编译为嵌套 `CompiledStateGraph` 作为父图节点（LangGraph 原生支持），自动获得子图 checkpointer/错误传播
3. 端口参数映射表持久化到节点 `params.mapping`，运行时做变量绑定
4. 模板引用：definition 表加 `template_id` 引用 + 固定版本锁定（后续 T11 加版本化）

**注意点**
- **子图数据隔离**：子图 state 与父图 state 分离（独立命名空间），仅通过端口映射通信——对应 HNFlow「子工作流拥有独立上下文」原则
- 递归深度限制：编译时检测嵌套深度（默认 ≤10 层，可配置），超限拒绝编译——防栈溢出
- 循环引用检测：definition 引用图的环在编译前拦截（比 T11 的运行时检测更早），报完整引用链
- 大文件传参：先做值传递，引用传递/写时复制留 T18 优化——别让本任务膨胀

**验证点**
- [ ] 3 层嵌套工作流编译执行成功，参数经端口映射正确传入返回
- [ ] 子图失败时父图收到明确错误且错误信息含完整节点路径
- [ ] 嵌套深度超限被拒绝编译
- [ ] 子工作流引用环（A 引 B、B 引 A）编译前报错

#### T10 运行期委派：子代理 checkpointer + 放开 task 递归

**内容**
1. `subagents/executor.py`：子代理 `checkpointer=True`（现 613 行硬编码 False），子代理状态持久化到 LangGraph checkpoint
2. 放开递归：`subagents/config.py` 的 `disallowed_tools=["task"]` 改为可配置（默认仍禁，工作流场景按需放开）
3. 工作流「委派节点」：subworkflow 节点可选「运行期委派」模式——节点执行 = 增强版 task_tool，委派给子工作流 agent 执行
4. 结果回传：委派完成后提取子代理最终输出写入端口

**注意点**
- **放开递归是安全敏感变更**：默认保持禁 recursion（防止无限循环消耗），仅工作流定义的委派节点显式开启，且带递归深度上限
- 子代理 checkpointer 开启后，父进程崩溃可恢复子代理进度——但 checkpoint 写入成本上升，注意 token/存储开销
- 子代理的执行复用 `_aexecute` 流程，别重写；只加持久化层
- 结果提取复用 `_extract_final_result`（现 166 行），保证与现有 task 工具行为一致

**验证点**
- [ ] 子代理崩溃后可从 checkpoint 恢复继续（单测模拟中断）
- [ ] 委派节点跑通：工作流 → 子工作流 agent → 结果回端口
- [ ] 默认配置下 task 工具仍被禁（无回归）
- [ ] 递归深度超限被拦截

#### T11 全局依赖图循环检测（定义层）

**内容**
1. 统一依赖图：聚合三类引用——工作流→子工作流（模板引用）、功能组→功能组（T8）、功能组→工作流（AI 节点关联）
2. `dependency_graph.py`：构建统一图，全局 DFS 循环检测，输出完整循环路径
3. 接入保存流程：`POST /api/workflows` 保存时自动执行，检测到环禁止保存并返回路径
4. CLI/脚本入口：`deerflow.workflow.check_cycles --definition <id>` 供 CI 与调试

**注意点**
- 三类引用必须进同一张图——HNFlow 明确「统一所有可引用实体的依赖图」，分开检测会漏环
- 检测结果排序稳定（同图同结果），便于单测断言
- 大图性能：节点数过千时考虑 SCC（强连通分量）算法而非朴素 DFS；初期数量级 DFS 够用，留性能注记

**验证点**
- [ ] 三类环（工作流环、功能组环、混合环）全部被检出且路径完整
- [ ] 合法大 DAG（100+ 节点）检测通过且耗时 <1s
- [ ] 保存带环工作流被 422 拒绝

---

### 阶段 E：人工与挂起

#### T12 HumanTask 数据模型 + 持久化

**内容**
1. persistence 新增表 `human_tasks`（id/workflow_run_id/node_id/status/description/inputs_snapshot/output_spec/validation_rules/checkpoint_ref/user_id/created_at）
2. 任务状态机：`pending → submitted / skipped / reopened / expired`
3. 校验规则存储：提交后按 `output_spec` + `validation_rules` 校验（格式/必填/命名），失败回 `reopened` 打回重交
4. CRUD API：`GET /api/human-tasks?status=pending`、`POST /api/human-tasks/{id}/submit|skip|reopen`

**注意点**
- 任务表是**唯一持久化主键**（HNFlow 8.8 节原则）：后续恢复链路全部以 HumanTask id 为准，checkpoint_ref 只是辅助定位
- 状态机是纯函数（`pending 可转 submitted/skipped`），非法转移直接拒绝——用枚举状态 + 转移表，别用自由字符串
- 输入快照（inputs_snapshot）体积控制：只存引用/摘要，大产物走 sandbox 文件路径引用
- 恢复失败语义：submit 后 checkpoint 恢复失败，任务回 `pending` 不丢用户输入（事务设计）

**验证点**
- [ ] 任务创建→提交→打回重交→再提交全状态流转单测
- [ ] 校验规则：必填缺失提交被拒
- [ ] API 层：pending 列表按 user 隔离

#### T13 统一挂起：interrupt 对接 HumanTask + 恢复链路

**内容**
1. 节点执行器支持 `interrupt()`：AI 节点内 LangGraph `interrupt()` / 人工节点执行时，统一生成 HumanTask 待办并挂起（`runtime/checkpoint_state.py` 与 `Command(resume=...)` 现有链路复用）
2. 恢复指令映射：`POST /api/human-tasks/{id}/submit` → 引擎按任务记录定位 checkpoint，`Command(resume=...)` 恢复对应节点，传入用户提交值
3. 事务一致性：HumanTask 持久化与 checkpoint 写入同一事务（复用 `persistence/` 事务模式），任一失败整体回滚
4. 封装透明：外层 subworkflow/复合节点只见「子工作流挂起，等待用户」，不感知内部是 AI 中断还是人工节点

**注意点**
- **这是改造中最易出错的接缝**：两套持久化（LangGraph checkpoint + HumanTask 表）必须事务一致，先写设计单测再实现
- 单节点单待办：同一节点多次中断生成多条独立待办，恢复时按 checkpoint id 精确对应
- 挂起期间运行状态保持 `WaitingForHuman`，与 DeerFlow 现有 run 状态机兼容（不引入新状态枚举破坏前端）
- 多轮/循环内中断先支持单次确认型，复杂场景降级为「AI 节点输出选项 → 用户选择 → 下一节点继续」（HNFlow 8.8 降级方案）

**验证点**
- [ ] AI 节点 interrupt → 生成待办 → submit → 精确恢复并继续执行
- [ ] 事务回滚：checkpoint 写入失败时待办不落库（或反之），无半状态
- [ ] 循环内中断恢复后迭代计数正确
- [ ] 外层子工作流看到的是统一挂起语义，无需感知内部类型

---

### 阶段 F：画布

#### T14 React Flow 画布接线 + node/edge CRUD

**内容**
1. 激活 `frontend/src/components/ai-elements/` 的 React Flow 基元（canvas/node/edge/controls/panel/toolbar），新建工作流画布页面 `/workspace/workflows/[id]`
2. 画布 ↔ definition JSON 双向映射：React Flow 节点/边 ↔ `WorkflowDefinition`（拖拽创建、连线、删除、参数编辑）
3. 与后端 API 对接：加载 `GET /api/workflows/{id}`、保存 `PUT`（保存前调后端校验，422 错误回显到画布）
4. 节点物料面板：按节点类型分类拖拽（流程控制/数据/工具/AI/人工/子工作流占位）

**注意点**
- **前端零重写**：ai-elements/ 组件已存在，只做接线；不引入 X6（既定决策③：React Flow）
- 端口连线校验在前端做实时反馈（类型不匹配禁连），后端校验兜底——两处逻辑必须一致，共享同一套规则说明
- 中文界面文案与现有 workspace 风格统一（DeerFlow 前端有 i18n 基础）
- 保存采用「草稿模式」：运行中禁止编辑（复用 HNFlow 运行时只读概念），先做只读标记不做复杂冲突处理

**验证点**
- [ ] 拖拽 5 节点连线保存 → 刷新后画布还原一致
- [ ] 端口类型不匹配时连线被拒且 UI 有反馈
- [ ] 后端 422 校验错误在画布定位到具体节点高亮
- [ ] 前端 `pnpm check` + 相关组件单测通过

#### T15 子工作流节点渲染 + 节点表单面板

**内容**
1. subworkflow 节点渲染：画布上可展开/折叠（内联子图展示子节点），双击进入内部编辑区（子 definition 编辑页）
2. 节点表单面板：侧面板按节点类型渲染参数表单（端口映射、AI 节点模板输入、人工节点描述/校验规则）
3. 子工作流参数映射 UI：从内部子节点端口选暴露端口、参数映射（对应 HNFlow 接口封装）
4. 版本角标占位：subworkflow 节点右上角显示引用版本号（版本交互完整功能留 T17 后）

**注意点**
- 子图编辑是递归页面：深层嵌套注意页面栈/浏览器历史处理，避免层级过深卡死
- 参数映射表单是子工作流节点体验核心，先做「输入端口映射」，「参数映射」（内部节点参数对外）留 T18 完善——控制任务规模
- 表单组件复用现有 workspace 的 CodeMirror/表单模式，不新引 UI 库

**验证点**
- [ ] 双击 subworkflow 节点进入子图编辑，保存后父图端口映射正确
- [ ] 折叠/展开状态与 definition 一致
- [ ] AI 节点表单可输入指令模板并持久化到 params

#### T16 运行监控/调试面板

**内容**
1. 画布运行视图：节点状态徽标（Idle/Running/Success/Failed/WaitingForHuman），SSE 事件实时驱动
2. 调试面板：执行日志（级别过滤 + 节点直达）、上下文变量快照（三层 global/workflow/node）、失败节点高亮 + 点击直达
3. 运行控制：开始/暂停/终止/重试按钮（对接 T6 run API）
4. 断点续跑展示：重启后恢复的 run 在画布上显示「从 XX 节点续跑」

**注意点**
- SSE 事件消费复用现有 message-list 的流式管道（不要另起 WebSocket），事件顺序按 seq 去重
- 变量快照读取 `GET /api/workflows/{id}/runs/{rid}/state`，前后端定义固定 JSON 契约（对齐 T6）
- 失败高亮与错误溯源：错误信息携带完整节点路径（`顶层 > 发布 > 资源导入`），前端按路径展开子图定位
- 状态徽标颜色/语义与 HNFlow 既有设计一致（Success 绿/Failed 红/WaitingForHuman 黄）

**验证点**
- [ ] 运行中画布实时更新节点状态
- [ ] 失败节点点击直达对应子图位置
- [ ] 终止/重试按钮行为正确
- [ ] 断点续跑场景下画布正确显示恢复点

---

### 阶段 G：对话侧

#### T17 lead agent 工作流工具（生成/编辑/校验）

**内容**
1. 新增两个 builtin 工具：`generate_workflow(prompt)`（自然语言 → WorkflowDefinition JSON，走 T2 校验后返回）、`edit_workflow(definition_id, instruction)`（按指令修改定义）
2. 工具内部复用现有 agent 能力：生成时先调 T2 校验器，失败自动修正重试（≤2 次）
3. 身份与能力注入：工具执行时按 definition 的 resolvedGroups 激活对应功能组（复用 slash activation 语义），让 agent 理解领域能力边界
4. 安全护栏：生成结果必须通过图结构校验才可保存；涉及危险操作（bash/写文件）节点默认标记「待人工审核」（复用 `review`/guardrails 机制）

**注意点**
- 生成工具的提示词工程是关键：system prompt 里注入节点类型枚举 + 端口类型规则 + 命名约束，避免生成非法定义
- **禁止工具自行绕过校验**：任何生成结果必须过 `validate_definition`，这是「Agent 只能调用已注册能力」的强制边界
- 危险节点默认「待审核」标记要落盘（definition 元数据），后续运行时遇到未审核危险节点要求确认（T18 联动）
- 工具名与现有 builtin 冲突检查（`tools/tools.py` 去重逻辑）

**验证点**
- [ ] 「创建一个发布流程，包含资源导入、打包、测试」生成合法定义并可通过校验
- [ ] 生成含环/端口错误的定义被自动修正或拒绝
- [ ] 危险节点（bash）默认带待审核标记
- [ ] 对话中可自然语言修改已存在工作流

#### T18 对话调度/进度汇报/异常修复

**内容**
1. 调度工具：`run_workflow(definition_id, params)`、`pause_workflow`/`resume_workflow`/`cancel_workflow`（包装 T6 run API）
2. 进度汇报：agent 订阅 run 事件流，关键节点完成时主动汇报；异常第一时间通知并分析
3. 异常修复：节点失败时 agent 读取 run events 定位失败原因，给出修复建议或自动调参重试（复用现有 agent 的调试能力 + `review_skill_package` 类似模式）
4. 人工任务联动：agent 能看到 pending HumanTask，提醒用户处理（读取 T12 API）

**注意点**
- 调度工具与画布控制走同一 API（双入口一致性），禁止工具走旁路
- 进度汇报频控：事件风暴时聚合汇报（如每 N 节点或超时汇报一次），别逐节点刷屏
- 异常修复的自动重试仅限幂等节点（T5 标注），非幂等节点必须转人工确认——与 HNFlow 幂等原则一致
- 本任务收尾阶段：将 T9 遗留的「引用传递/写时复制」与 T15 遗留的「参数映射」按需补做，形成闭环

**验证点**
- [ ] 对话中发起运行，收到关键节点进度汇报
- [ ] 人为制造节点失败，agent 给出可操作修复建议
- [ ] 对话中查询 pending 任务并提示处理
- [ ] 双入口（画布/对话）控制同一 run 行为一致，无竞态

---

### 执行顺序总览（关键路径）

```
T1 → T2 → T3 ──────────────→ T14 → T15 → T16
      └→ T4 → T5 → T6 ─────→┬─┴──────────────┘
            │                 ├→ T13 (依赖 T12)
      └→ T7 → T8 → T9        └→ T17 → T18
            └→ T11
T10 (依赖 T4，可与 T9 并行)     T12 (独立，尽早做，供 T13)
```

- 关键路径：T1→T2→T3→T14→T15→T16（定义层→画布），与 T4→T6 执行线并行推进
- T12（HumanTask 模型）无依赖，可第一时间启动
- T7（Skills 版本化）无依赖，可并行；它是功能组体系的地基，越早越好

## 七、一句话总结

> DeerFlow 改造 HNFlow 式平台 = **新增 `workflow/` 定义+编译层（纯 JSON → LangGraph 图）+ 前端画布接线 + Skills 版本化补齐**。执行引擎、断点、挂起、MCP、沙箱、懒加载全部白捡；形态 = Web 服务 + 本地部署（不保留桌面），后端沿用 Python，画布用 React Flow，确定性工作流与自主对话并存。
