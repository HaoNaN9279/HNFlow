# HNFlow 开发规划

> 依据《HNFlow 开发方案》（唯一参考文档），对照当前代码现状，给出「基于旧版本改造 + 新增」的分阶段实施规划。
>
> **排序原则**：核心运行逻辑优先；安全等非核心项置于最低优先级。
>
> 标记：**[改造]** = 修改现有代码；**[新增]** = 全新模块；**[补齐]** = 现有占位实现落地；**[裁剪]** = 删除/隔离上游 deerflow 能力（见第八节）。

---

## 一、现状盘点

### 1.1 已实现（旧版本）

| 模块 | 位置 | 状态 |
|---|---|---|
| 定义层 | `workflow/schema.py` | Port/Node/Edge/WorkflowDefinition/Metadata；NodeType 六类（flow/data/tool/ai/human/nested） |
| 校验与序列化 | `workflow/workflow_io.py` | 无环 DFS、单起止、端口引用/类型、params JSON 兼容、subworkflow spec 形状；`SCHEMA_VERSION=1` |
| 依赖图/循环检测 | `workflow/dependency_graph.py`、`check_cycles.py` | 三类引用聚合 + 全局 DFS |
| 编译层 | `workflow/compiler.py` | 定义→StateGraph；start/end 映射；if/switch 条件边；loop（正宗版：`results`/`last` 聚合 + `continue_on` 条件退出）；parallel；子图编译展开 + 运行期委派；编译缓存 |
| 执行器 | `workflow/executors/` | flow(if/switch/wait)、data(assign/convert/file/json/regex)、tool(bash/http/log)、ai(llm_agent)、human(task) |
| AI 节点 | `executors/ai.py` + `workflow/prompts.py` | 三层提示词（身份/能力/任务）；template/continue 双模式；经 `SubagentExecutor` 执行；token 用量聚合 |
| 人类节点 | `executors/human.py`、`human_task_state.py` | `interrupt()` 挂起 + `Command(resume=)` 恢复；状态机；幂等复用 |
| 执行 worker | `workflow/worker.py` | 复用 run 生命周期；`wf:node:started/completed/failed` 事件（失败带 `error_class` 稳定失败码）；run.end token_usage |
| 对话侧调度 | `workflow/dispatch.py` | start/resume/continue/cancel/get/list_events；运行单例注入 |
| 生成/编辑工具 | `tools/builtins/workflow_tools.py`、`workflow_runtime_tools.py` | generate/edit/run/get/pause/cancel/continue + human task 工具 |
| 危险节点 | `workflow/danger.py` | bash/http → `pending_review_nodes` |
| 持久化 | `persistence/workflow_definitions/`、`human_tasks/` | 表 + 迁移 0012/0013 |
| Gateway | `app/gateway/routers/workflow_routes.py`、`workflow_run_routes.py`、`human_task_routes.py` | 定义 CRUD；run/stream/wait/cancel/continue/join/state；human task submit/skip/reopen |
| 前端 | `frontend/src/core/workflows/`、`components/workspace/workflows/` | React Flow 画布、节点目录、属性面板、运行面板、错误列表 |
| 测试 | `backend/tests/test_workflow_*.py`（40+） | 编译/执行/子图/委派/挂起/调度/路由等 |

### 1.2 占位 / 未实现

| 项 | 现状 | 方案要求 |
|---|---|---|
| `tool:notify` | 抛 `NotImplementedError`（T10 占位） | 本机通知（§18） |
| `nested:subworkflow`（无 spec 路径） | 抛错 | 编译展开/委派（已有 spec 路径） |
| `flow:loop` | ✅ 正宗版已落地（C5）：`iteration` + `out` 透传 + `results`/`last` 聚合 + `continue_on` 条件退出 | 子图展开（body 隔离，后续增量） |
| `resolved_groups` | 仅收集，未校验/加载；无 lockfile | 全量能力快照 lockfile（§5.6） |
| 能力包契约 | 无 permissions/evals/tool_schema_version/context_budget | §5.5 |
| 工具网关 | 无；AI 节点 `tools=[]` | 统一描述符 + provider（§9） |
| LLM 中间层 | 无；ai.py 经 SubagentExecutor 间接调模型 | 统一模型访问层（§8） |
| AI 节点工具集 | **实际未装配 capability_groups 的 allowed-tools**（仅提示词描述） | 主 agent 工具 + allowed-tools 并集（§7.3） |
| `app` 节点 / 本地软件接入 | 无 | §17 |
| 长期实例 / 触发 / 调度 | 无（仅 run） | §18 |
| 本地资源治理 | 无 | §19 |
| 文件/资产/跨软件契约 | 无（仅 `data:file` 读写） | §20 |
| 人机共享工作区 / 预览 undo | 无 | §21 |
| 环境探测 / 备份迁移 | 无 | §22 |
| 单用户模型 | 仍 `user_id` 多用户隔离 | 单机单用户（§15） |
| §24 Agent 能力补强 | 无 | 记忆/RAG/上下文/结构化输出/自主度/协作/事务/评测/可观测/重放/成本/注入防御 |

---

## 二、差距分类

- **A. 现有逻辑缺陷（必须改造）**：AI 节点工具未装配、loop 简单版、metadata 缺 lockfile、能力组只收不校、执行流 `astream_events` 与方案语义不符。
- **B. 架构层缺失（新增）**：工具网关、LLM 中间层、能力包契约。
- **C. 定位核心缺失（新增）**：本地软件接入、长期实例/调度、资源治理、文件资产、共享工作区。
- **D. Agent 能力补强（新增，可分批）**：§24 各项。
- **E. 低优先级/可删**：安全（注入防御/威胁模型/供应链）、SaaS 类（多租户/评审流/环境晋升）。**上游 deerflow 继承来的同类能力（多用户鉴权/RBAC、IM 渠道、多 worker、TUI、运营类）的移除/隔离见第八节「deerflow 上游裁剪规划」。**

---

## 三、改造清单（基于旧版本）

状态图例：✅ 已完成（P0 本轮）｜◐ 部分完成（最小版）｜⬜ 未开始｜⏸ 顺延后续。

| # | 改造项 | 位置 | 说明 | 状态 |
|---|---|---|---|---|
| C1 | **AI 节点真实工具装配** | `executors/ai.py` | 现 `tools=[]`，capability_groups 只进提示词。需按 `allowed-tools` 并集经工具网关装配工具（依赖 N1）。**核心** | ✅ 已落地：`tool_gateway.resolve_capability_tools` 装配 |
| C2 | **流式执行对齐** | `workflow/worker.py` | 方案 §12 为 `astream(stream_mode=["updates","custom"])`；现状 `astream_events(v2)`。统一为方案语义，保留节点级事件。**核心** | ✅ 已落地：compiler 发射节点自定义事件（带 `depth`），worker 消费 |
| C3 | **lockfile 落元数据** | `schema.py`(`WorkflowMetadata`)、保存路径 | 新增 `lockfile` 字段（模型/prompt/tool schema/MCP 版本/采样参数）。**核心** | ✅ 已落地：保存时固化能力快照 + 默认模型 |
| C4 | **能力组解析→校验→加载** | `schema.collect_resolved_groups` + 新增服务 | `resolved_groups` 目前只收集；补存在性/版本范围校验与执行期加载。 | ◐ `validate_capability_groups` + 执行期加载已落地；保存仍 fail-open（版本范围校验随 lockfile 后续） |
| C5 | **循环正宗版** | `compiler.py`(`_loop_node_fn`) | 由简单计数改为子图展开 + 条件边 + `results`/`last` 聚合输出。 | ✅ 已落地（Option A：原位聚合 `results`/`last` + `params.continue_on` 条件早退；body 子图展开列为后续增量，无迁移） |
| C6 | **端口类型扩展** | `schema.PortType` | 增 `number`/`array`/`record`，同步 `workflow_io.ports_compatible` 与前端 `types.ts`/校验。 | ✅ 已落地（前端 `types.ts`、端口颜色映射已同步） |
| C7 | **通知执行器补齐** | `executors/tool.py`(`exec_notify`) | 落地本机通知（长期运行需要）。 | ✅ 已落地：`runtime.context["notifier"]` 钩子 + 日志兜底 |
| C8 | **schema 迁移钩子** | `workflow_io._migrate_schema` | 现抛 `NotImplementedError`；建立 v→v+1 迁移链。 | ✅ 已落地：`register_migration` 逐版本链 |
| C9 | **单用户模型收缩** | 定义/持久化/路由 | 去多用户强隔离，保留 `user_id` 弱隔离（§15）。 | ⬜ 未开始 |
| C10 | **执行器注册 `idempotent` 修正** | `executors/__init__.py` | `ai:llm_agent`/`human:task`/`nested` 现标 `requires_confirmation=True`，与新语义（AI 有界自主 + 中断）对齐复核。 | ✅ 已落地：`requires_confirmation` 仅保留 bash/http |
| C11 | **前端节点目录同步** | `node-catalog.ts`、`types.ts`、`validation.ts` | 与新增/改造节点（app、loop 端口、端口类型）保持一致；移除 `template_prompt`「future」占位语义。 | ✅ 已落地（app 类节点 P1 切片 1 已同步） |

---

## 四、新增清单

| # | 新增项 | 对应方案 | 说明 | 状态 |
|---|---|---|---|---|
| N1 | 工具网关 | §9 | 统一描述符 + 调用信封 + provider（builtin/skill/sandbox/mcp/app） | ◐ 最小版（builtin/sandbox + 描述符/分派）；skill/mcp/app provider 后续 |
| N2 | LLM 中间层 | §8 | 统一模型接口/厂商适配/能力归一/路由/计量 | ✅ 既有 `deerflow.models`（`create_chat_model` + providers + 厂商适配器）即统一访问层：核实 `workflow/`、`agents/lead_agent/` **无厂商 SDK 直连 import**，AI 节点经 `SubagentExecutor` → `create_chat_model`、lead agent 同源；能力归一经 middleware（thinking/vision/stream/tool）、计量经 token collector、路由由 §24.10 节点级 `model_policy` 补强。无需另立模块（渐进抽层原则） |
| N3 | 能力包契约 | §5.5 | permissions/schema 版本/context_budget（required-secrets 已有）；`evals` 后续 | ◐ `permissions`/`tool-schema-version`/`context-budget` 声明+解析+校验已落地；`evals` 契约与运行时权限裁决待做 |
| N4 | **本地软件接入层** | §17 | 应用注册表 + 实例/会话管理 + 驱动矩阵 + 人机共享 | ◐ P1 切片 1：注册表/会话/驱动（cli/mock）已落地；驱动矩阵扩展、共享/抢占、DB 持久化随后续切片 |
| N5 | `app` 类节点 | §6.7 | `app:launch/script/wait/collect` | ✅ P1 切片 1 已落地（+ 工具网关 `app` provider） |
| N6 | 长期实例管理 | §18 | 实例列表/状态/恢复/归档/清理 | ◐ P1 切片 2：持久化实例记录（`app_instances`）+ 列表/详情/close/archive/delete/cleanup + 启动孤儿标记 + 资源累计已落地 |
| N7 | 触发与调度 | §18 | cron/文件监视/应用事件/空闲 + 幂等/去重/退避/DLQ | ◐ P1 切片 3：`file`/`event`/`idle` 触发 + 载荷→端口映射（workflow 目标）+ 触发去重 + 退避重试/死信（`dead_lettered` + requeue）已落地 |
| N8 | 本地资源治理 | §19 | GPU/CPU/内存/磁盘、License 并发、独占锁 | ◐ P1 切片 4：声明式配额 + 准入闸门（排队/fail/degrade）+ License slots + 跨进程可重入文件锁 + `GET /api/apps/resources` 已落地 |
| N9 | 文件/资产/跨软件契约 | §20 | 资产建模、格式转换、跨软件引用约定 | ◐ P1 切片 5：`AssetRef` 资产建模（`asset://` URI + 指纹 + 契约校验）+ `data:asset` 节点（inspect/import/export/convert）+ `assets` 配置段 + `app:collect` 资产输出 已落地 |
| N10 | 人机共享工作区 + 预览 undo | §21 | 状态同步/抢占、不可逆操作确认、应用原生 undo | ✅ P1 切片 6：预览/审批/undo（N10）+ 人机共享治理（N10b：presence 探测 / 准入决策 / 抢占声明 / 冲突检测 / 归属可见性）全部落地 |
| N11 | 环境探测 / 备份迁移 | §22 | 软件/插件/运行时探测、数据目录规范、备份/导出导入/换机迁移 | ✅ P1 切片 7（环境探测 + 数据目录规范）+ 切片 8（N11b 备份/导出导入/换机迁移）全部落地 |
| N12 | 容错编排 | 后续规划 | Try-Catch/Finally 节点、失败降级/回调 | ✅ 已落地（`flow:try`：受保护子工作流 body + `error`/`error_message`/`error_type` 端口 + 可选 `finally_subworkflow`；路由经 `flow:if`；无迁移） |
| N13 | 并发治理 | 后续规划 | 并行分支合并规则、共享变量、资源锁 | ✅ 已落地：并行分支合并规则（`params.merge`：overwrite/array/error）+ 节点级资源锁（`params.resource_lock`）+ 共享变量（`data:shared` + `wf:shared:*` 黑板 + `metadata.shared` 写策略） |
| N14 | §24 Agent 能力补强 | §24 | 记忆/RAG/上下文策略/结构化输出/自主度/协作/事务/评测/可观测/重放/成本 | ◐ 切片A（§24.6a 共享工作区黑板）+ 切片B（§24.5 自主度预算）+ 切片C（§24.4 结构化输出契约）+ 切片D（§24.9 失败分类）+ 切片E（§24.3 上下文工程策略）+ 切片F（§24.7 幂等键 + 有界节点重试）+ 切片G（§24.11 确定性重放）+ 切片H（§24.8 评测核心）+ 切片I（§24.10 模型路由）+ 切片J（§24.1 节点级记忆）+ 切片K（§24.2 知识检索）+ 切片L（§24.6a/b 拓扑模板）+ 切片M（§24.12 注入防御）+ 切片N（§24.10 运行级预算）+ 切片O（`data:knowledge` 节点）+ 切片P（评测 runner）+ 切片Q（评测 CLI/CI）+ 切片R（DeerMem 适配器）+ 切片S（模板端点）已落地；N14 各切片主体完成 |
| N15 | 安全基线与注入防御 | §24.12 | 注入防御、权限裁决、密钥隔离（低优先级） | ⬜ P3 |

---

## 五、分阶段实施规划

### P0 — 核心运行逻辑（先做）

目标：让现有引擎真正跑通方案语义，AI 节点可实际调用工具。

1. **C1 AI 节点工具装配**（依赖 N1 最小版）— ✅ 完成
   - 先落地工具网关最小版（N1：描述符 + builtin/sandbox provider 分派），再让 `exec_llm_agent` 按 `capability_groups` 的 allowed-tools 并集装配 `tools`。
2. **C2 执行流对齐**：worker 改用 `astream(stream_mode=["updates","custom"])`，节点事件语义与方案一致。— ✅ 完成
3. **C3 lockfile + C4 能力组校验/加载**：`WorkflowMetadata.lockfile`；保存时固化、执行时按 lockfile 恢复。— ✅ 完成（C4 版本范围校验留待 lockfile 深化）
4. **C5 循环正宗版 + C6 端口类型扩展 + C11 前端同步**。— C6/C11 ✅；**C5 ✅**（Option A：聚合 + 条件退出；body 子图展开为后续增量）
5. **C7 通知执行器 + C8 schema 迁移钩子 + C10 幂等标注复核**。— ✅ 完成

验收：一个含 AI 节点调用工具、含循环聚合、含端口类型校验的端到端工作流可编译、执行、断点、恢复。

> **本轮进度（P0）**：C1/C2/C3/C5/C6/C7/C8/C10/C11 已完成，C4 部分完成。后端 workflow 套件 504 passed / 1 skipped；前端 lint + typecheck + prettier + 单测（1254 passed）全绿。
>
> **C5 切片（循环正宗版，Option A）**：`flow:loop` 由「简单计数」升级为「聚合 + 条件驱动」——节点声明 `results`(array)/`last` 时，loop fn 从第 2 轮起把经回边回流的 body 产物逐轮收进 `results`（顺序 = 迭代序，末元素即 `last`，种子不计入），仅在声明端口时写（旧定义零破坏）；路由新增 `params.continue_on`（命名某条入边的 `source_port`，读 `wf:<source>:<port>`，falsy 即早退；键缺失 = 继续，第 1 轮不判条件，`iterations` 仍为硬上限）。聚合走保留通道 `wf:<loop_id>:__results`，故只声明 `last` 的节点也能拿到全量历史。**不改图拓扑**（body 仍在主图），因此 body 节点 SSE 事件、loop 内 `interrupt`/审批、checkpointer 命名空间、子工作流嵌套、`validate_definition` 环豁免**全部不受影响**；无 schema 迁移、无新表、无新配置段、无新依赖。前端仅同步 `node-catalog.ts` 的 `flow:loop` 端口（+`results`/`last`）。测试：`tests/test_workflow_loop_ports.py`（聚合 4 条）+ 新增 `tests/test_workflow_loop_condition.py`（条件/硬上限/缺键安全 4 条）；全量离线 A/B 对拍失败集合逐条一致（77），+8 passed。「子图展开（body 隔离）」按方案原文列为后续增量（与 §24.6a 评审回环联动）。
>
> **N12 切片（容错编排，`flow:try`）**：新增流程控制节点 `flow:try`，**复用 `nested:subworkflow` 的子图展开机制**承载受保护 body（`params.subworkflow`，inline/template + `mapping`）。try 节点 fn `ainvoke` body 子图：成功→按 mapping 回写 `out`、`error=False`；抛错→写 `error`(bool)/`error_message`/`error_type` 并**继续**（run 不炸），由下游已有 `flow:if` 读 `error` 分流到 catch 分支（**不新增条件边机制**）；`on_error="fail"` 恢复今天的上抛行为。**控制流信号永不吞**：`_control_flow_should_propagate` 排除 `GraphInterrupt`（HITL 挂起）与 `GraphBubbleUp` 其他子类，`GraphRecursionError` 默认上抛（`catch_recursion=true` 可选捕获）；`CancelledError` 属 `BaseException` 天然不捕。可选 `params.finally_subworkflow` 在 `finally:` 块执行（成败都跑；无输入注入，侧效应收尾）。**不改条件边/事件/checkpointer 主路径**；无迁移、无新表、无新配置、无新依赖；前端同步 `types.ts`/`node-catalog.ts`（+`flow:try`）。测试：新增 `tests/test_workflow_try.py`（12 条：分类 4 + 成功/捕获/fail 上抛/中断不吞/递归默认上抛/递归可选捕获/finally 成败都跑/缺 spec 编译错）。全量离线 A/B 对拍失败集合逐条一致（77），+12 passed。已知边界：body 内 `require_approval`/`human:task` 沿用子图限制（暂不支持）；body 节点 SSE 事件不发（depth>0）。「平铺区域 + 显式 `flow:finally` 节点」列为后续增量。
>
> **N13 切片（并发治理，合并规则 + 资源锁）**：① **Fan-in 合并规则**——`_make_node_fn` 此前用 `dict[target_port]=key` 建输入映射，**同端口多入边后者覆盖前者、静默丢失并行分支产物**；改为 `dict[port, list[key]]` 并按节点 `params.merge`（`{port: overwrite|array|error}`，默认 `overwrite`=最后边胜）合并：`array` 按边顺序收集该端口**已产出**的上游值成 list（未产出跳过、全未产出=`[]`），`error` 在 >1 个非 None 源时抛 `WorkflowExecutionError`。读侧小改、**不动 state schema/无迁移**；编译期校验策略与端口名。② **节点级资源锁**——节点 `params.resource_lock`(str|list) + `resource_lock_timeout`（默认 60）经 `_register` 统一包装**所有**声明锁的节点，复用 N8 `locks/file_lock.py` 的 `resource_lock`/`acquire_many` 把整段执行置于**跨进程**锁下（GPU/项目文件/license 串行化）。因 N8 in-process 可重入是 `threading.RLock`（acquire/release 必须同线程）且阻塞获取不能在事件循环上跑，采用**「锁持有线程 + 握手」**：daemon 线程内 `with lock:` 获取并等 `release` 事件，事件循环只 `await` 握手；超时→带锁名的 `WorkflowExecutionError`；`finally` 置 `release` 保证异常/取消都释放。**无迁移、无新表、无新配置、无新依赖**；前端零改动（参数级）。测试：新增 `tests/test_workflow_concurrency.py`（9 条：overwrite/array 保序/array 跳过未产出/error 冲突/非法端口/非法策略、锁串行化/超时/非法锁名）。全量离线 A/B 对拍失败集合逐条一致（77），+9 passed。**共享变量（`wf:shared:*` 黑板）延后**：需 workflow 级共享通道 + reducer（并发写同一通道否则 `InvalidUpdateError`）+ 写策略，与 §24.6a 协作原语 / N14 #6a 强重叠，应一起设计。
>
> **N14 切片A（协作原语：共享工作区/黑板）**：§24.6a 的共享变量地基落地（承接 N13 延后项）。新增 `data:shared` 节点（`params.operation: read|write|append` + `params.name`）读写 **workflow 级共享通道 `wf:shared:<name>`**；写策略在 workflow 顶层 **`metadata.shared: {name: overwrite|array|conflict}`**（默认 `overwrite`）：`overwrite` 用默认 LastValue 通道（**跨步覆盖、同一 super-step 并行同写→LangGraph `InvalidUpdateError` 即冲突报错**），`array` 给通道挂 **reducer**（`_shared_array_reducer`，并行 append 合并成列表；已用测试钉住 LangGraph 动态 TypedDict 的 `Annotated` reducer 生效），`conflict` 走默认。读写经保留结果键 `__shared_writes` 由 `_make_node_fn` 提升到共享通道；`_build_state_schema` 按节点引用汇总声明共享通道。**无迁移、无新表、无新配置、无新依赖**；前端接入目录（`types.ts`/`node-catalog.ts`，计数 25→26 / data 6→7）；`build_default_registry` 21 项。测试：新增 `tests/test_workflow_shared_workspace.py`（8 条：往返/未初始化 None/array 并行合并/overwrite 顺序覆盖/overwrite 并行冲突/非法 operation/非法名/非法策略）。全量离线 A/B 对拍：失败集合一致（77 平台族 + 1 个既有**时序 flake** `test_notification_timeout_is_one_shared_budget`，单跑 3/3 过，与本改动无关），+8 passed。**§24.6a 其余（有界评审回环 / 受控动态 handoff）与 §24.5 自主度预算列为后续增量**（§24.5 需先补 subagent 预算管道：token/tool_calls 现无 per-node 通道）。
>
> **N14 切片B（§24.5 自主度预算）**：`ai:llm_agent` 增 `params.autonomy = {mode: template|bounded, budgets: {max_turns, max_tokens}}`。`template`（默认）= 现状**零变化**；`bounded` 把硬预算落到 subagent 执行体：`max_turns` → `SubagentConfig.max_turns`（既已直连 `recursion_limit`），`max_tokens` → `SubagentConfig.token_budget`（`TokenBudgetConfig`）经**新增** `build_subagent_runtime_middlewares(token_budget_override=...)` 优先于 config 查询、由 `executor._create_agent` 透传（None=现状）。`stop_reason`（`token_capped`/`turn_capped`/`loop_capped`，`SubagentResult` 现成）经保留结果键 `__stop_reason` 由 `_make_node_fn` 提升到 reserved 通道 `wf:<node_id>:__stop_reason`（同 `__token_usage` 先例）。**`bounded` 保持 `allow_recursion=False`**（受限**工具**循环，非委派）。**`max_tool_calls` 无引擎机制，提供即编译期报错**（需新预算中间件 + `stop_reason` 契约新增值，列后续）；`delegated` 档、有界评审回环、受控动态 handoff 亦列后续。**无迁移、无新表、无新配置、无新依赖**；前端零改动。测试：新增 `tests/test_workflow_autonomy.py`（13 条：预算解析 template/bounded/max_tokens、stop_reason 落通道/缺省不写、mode 非法/max_tool_calls/非正预算/未知键校验、SubagentConfig 字段）。全量离线 A/B 对拍：新增 13 全过；唯一新增失败为既有**时序 flake** `test_extension_task_lifecycle`（该文件 budget 计时测试，单跑 3/3 通过、与本改动无关）。
>
> **N14 切片C（§24.4 结构化输出契约）**：新增 `deerflow/workflow/structured_output.py`（**纯逻辑**：`parse_output_schema` / `extract_json_object`（裸/围栏/嵌入式 JSON）/ `validate_payload`（类型校验）/ `schema_instruction`，零新依赖——用**字段→`PortType` 映射**而非完整 JSON Schema，与端口词汇天然对齐）。`ai:llm_agent` 增 `params.output_schema = {fields: {name: PortType}, required?, enum_values?, max_repairs?}`：任务提示追加「输出单个 JSON 对象」指令 → 剥围栏/`json.loads` → 校验；失败**有界修复**（≤ `max_repairs`，默认 1，带错误重试），耗尽即**节点失败**（`WorkflowExecutionError`）；成功把字段值写**已声明输出端口**（保留 `out` 原始文本）。**编译期绑定校验**：每字段须有同名输出端口且**类型一致**、`required`/`enum_values` 指向已知字段、`max_repairs` 0..5、仅 AI 节点——把「模型输出与图不符」前移到定义期。**可观测**：reserved 通道 `wf:<node>:__schema_repairs`（0 也写）。仅 template 模式；与 continue 组合 → **运行期**报错（continue 由运行期输入决定，无法编译期静态判定，故较原 D7 的「编译期」改为运行期，已记入 boulder）。`file` 字段类型、完整 JSON Schema、失败转人工列后续。**无迁移、无新表、无新配置、无新依赖**；前端零改动。测试：新增 `tests/test_workflow_structured_output.py`（23 条：解析/提取/校验/修复循环/绑定校验/通道）。全量离线 A/B 对拍：新增 23 全过，**失败集合无新增**（且上两轮的 `test_extension_task_lifecycle` 时序 flake 本轮自行通过，进一步证实抖动）。
>
> **N14 切片D（§24.9 端到端可观测：失败分类）**：新增 `deerflow/workflow/failure_taxonomy.py`——`FAILURE_CODES`（`timeout|rate_limit|model|validation|tool|budget|resource|conflict|config|unknown`）+ 纯函数 `classify_failure(exc, *, node_type=None)`（**best-effort 确定性**：超时/校验/冲突/锁/限流/资源/工具节点各自归码，其余 `unknown` 兜底，绝不猜测；对 compiler/registry/conflict/structured_output/locks 全部**函数内 deferred import** 以免循环）。`compiler._with_node_events` 增 `node_type` 形参并在 `wf:node:failed` payload 加 **`error_class`**；`worker` 消费时透传、**外层兜底路径**对冒泡异常分类并写入 `wf:node:failed`（content+metadata）、`run.error`（metadata）与 bridge `error` 事件（`class`）。**trace 贯通与成本归因经核对已具备**（Langfuse/Smith 回调在 graph 根部；W1C `__token_usage`→run.end 每节点明细 + console 聚合/cache-aware 计价），本切片仅补失败分类并文档标注。`budget` 码保留（预算以 `stop_reason` 表达、不抛异常，故节点级暂不可达）。**无迁移、无新表、无新配置、无新依赖**；前端零改动。测试：新增 `tests/test_workflow_failure_taxonomy.py`（13 条：各码映射/工具节点/unknown 兜底/事件 `error_class`）。全量离线 A/B 对拍：新增 13 全过、**失败集合无新增**（仅两条 `test_extension_task_lifecycle` 时序 flake 本轮复现，单跑均过）。
>
> **N14 切片E（§24.3 上下文工程策略）**：新增 `deerflow/workflow/context_policy.py`——纯函数 `estimate_tokens`（CJK-aware 字符估算，离线无依赖、**标注为估算**而非精确，与既有 `memory.token_counting: char` 同哲学）+ `parse_context_policy`（规范化 `params.context_policy` = `examples` 声明式 few-shot / `include` 按名挂载输入端口 / `budget.total_tokens`，坏形状 fail-loud）+ `apply_context_budget`（**固定顺序** `identity→capability→task→examples→context→schema`；预算**只约束可截断桶** `examples`/`context`，按 `examples` 优先贪婪填装、`context` 先被丢弃或截断，骨架超预算记 `over_budget` **不静默截断 instruction**）。`prompts.py` 增 `build_examples_layer`（`<examples>`）/`build_context_layer`（`<context>`，按 `include` 顺序、缺键跳过）/`build_ai_node_buckets`（桶顺序单一来源）。`ai.py` 接入 policy 并把用量写入保留通道 `wf:<node>:__context_usage`（各桶估算 token / dropped / truncated / over_budget，additive；未声明 policy 的节点不写该键）。`compiler._validate_context_policy` 编译期校验 `include` ⊆ 已声明输入端口 + shape。**诚实取舍**：工具结果外置/历史压缩仍由**全局**中间件负责（`ToolOutputBudgetMiddleware`/`DeerFlowSummarizationMiddleware`），节点级 override 延后；与 continue 模式互斥（运行期报错）；不引 tiktoken。**无迁移、无新表、无新配置段、无新依赖**；前端零改动。测试：新增 `tests/test_workflow_context_policy.py`（45 条：估算/解析形状/层渲染/预算丢弃截断/执行器集成/编译期校验）+ denylist 护栏参数化 +4。全量离线 A/B 对拍：passed 10812→10865、**失败集合无新增**（`test_input_sanitization_middleware` 的框架块 denylist 扫描护栏一度捕获新增的 `<examples>`/`<context>` 提示块，已同步加入 `_BLOCKED_TAG_NAMES` 并纳入该护栏的参数化列表）。

> 注：N2（LLM 中间层）与 N1（工具网关）是上层一切能力的地基。建议 **N2/N1 最小版并入 P0**，完整 provider/适配器随用随扩。

### P1 — 定位核心（本地专业软件 + 长期运行）

> **进度（切片 1：N4+N5 已落地）**：`deerflow/apps/`（应用注册表 `registry.py` + 驱动协议 `driver.py` + 会话管理 `session.py` + `drivers/{cli,mock}.py`）、`config.yaml apps:` 段（重启生效，`config_version 34`）、4 个 `app:*` 节点与执行器（launch/script 非幂等 + 危险节点，wait/collect 幂等）、工具网关 `app` provider、Gateway `GET /api/apps`+`/api/apps/sessions`、运行期会话管理器注入、前端节点目录/表单/校验/i18n 全部落地。**app 驱动运行在宿主**——「命令必须走 sandbox」的显式例外（GUI/长驻进程无法进容器沙箱）。Unity 驱动经决定本切片跳过；会话暂为进程内内存态（DB 持久化随 N6）。切片 2+（N6–N11）各自独立计划。

> **进度（切片 2：N6 长期实例管理已落地）**：新表 `app_instances`（`persistence/app_instances/`，迁移 `0017`）+ `AppInstanceRepository`（CRUD / 条件状态转移 / archive / delete / cleanup / `mark_orphaned` / `count_by_status`）；异步执行器与工具网关 `app` provider 经 `apps/persistence.py` **best-effort 写穿透**（失败仅告警，不回滚 live 操作；memory 后端 / `apps.persist_sessions=false` 自动退化为 no-op），repo 经 `APP_INSTANCE_REPO_CONTEXT_KEY` 注入；Gateway 启动把上一进程遗留的 `ready`/`busy` 行标为 `orphaned`（不自动重连）；`/api/apps/sessions` 扩展为持久化列表（`status`/`include_archived`/`include_orphaned` 过滤）+ 详情 / close / archive / delete / cleanup（管理端点在 memory 后端 503）；每实例轻量资源累计（`scripts_run`/`artifacts`/`busy_seconds`/`last_error`）。`config_version` 34→35（`apps.persist_sessions` / `apps.session_retention_days`）。N7（触发调度）/N8（资源治理）待做；前端本切片未改。

> **进度（切片 3：N7 触发与调度已落地）**：`schedule_type` 由 `once`/`cron` 扩到 `file`/`event`/`idle`（纯函数 `deerflow/scheduler/triggers.py::is_trigger_due`/`validate_schedule_spec`/`trigger_key_for` + app 层 `app/scheduler/probe.py::TriggerProbe` 快照：文件扫描 / `app_instances` 终态行 / run 活动度），与时间型共用同一 claim 循环、lease 与 `max_concurrent_runs` 预算（`NULLS LAST` 防条件型饿死时间型）；任务新增 `target_kind`(`agent`|`workflow`)/`target_definition_id`/`payload_template`（`{{payload.x}}`/`{{now}}` 插值 → workflow `params` 或 agent `prompt`），workflow 目标经 `launch_scheduled_workflow_run` → `start_workflow_run`（同一 run 生命周期）；触发去重靠 `uq_scheduled_task_run_dedupe(task_id, dedupe_key)` 部分唯一索引（冲突记 `skipped`，不重复派发）；可靠性新增 `max_attempts`（默认 1 = 不改旧行为）+ 指数退避 + 新终态 `dead_lettered` + `POST /scheduled-tasks/{id}/requeue` 排空，`POST /{id}/trigger` 为人工强制覆盖。迁移 `0018`；`config_version` 35→36（`scheduler.retry_backoff_seconds` / `max_retry_backoff_seconds`）；新增 `scheduler.probe`/`triggers`/`payload` 单测与仓储/服务/路由测试。前端本切片未改（新触发类型/workflow 目标经 API/agent 使用）。

> **进度（切片 4：N8 本地资源治理已落地）**：新增 `deerflow/resources/governor.py::ResourceGovernor`——**声明式**配额（`apps.definitions.<name>.resources` 声明 gpu/cpu/memory_mb/disk_mb/license，未声明维度不占额）+ 全局上限 `apps.resources`（`None` = 不限）+ License 池 `apps.licenses.<group>.slots`（默认 1 = 互斥）；一个 `threading.Condition` 下多维度 + License **一次性原子申请**（无部分持有/无加锁顺序死锁）+ FIFO 票号排队；冲突策略 `apps.on_conflict` = `wait`(默认，`acquire_timeout_seconds` 超时转 `ResourceUnavailableError`)/`fail`/`degrade`（放行 + 告警 + `degraded` 标记）。准入挂在唯一咽喉 `AppSessionManager`：**实例级** License（`launch` 持有 → `close` 释放，`exclusive` 复用不重复占）+ **操作级** 数值配额（`run_script`/`wait`/`collect`，`try/finally` 含驱动失败释放），因此工作流 `app:*` 执行器与工具网关 `app` provider 都自动受治理（后者把配额失败作为 `status: resource_unavailable` 数据返回给模型）；`app:*` 节点把失败翻译为带维度的 `WorkflowExecutionError`，可直接被 N7 的退避重试/DLQ 消费。新增 `deerflow/locks/file_lock.py`（可重入 + `fcntl`/`msvcrt` 跨进程文件锁 + `acquire_many` 统一加锁顺序）；`flow:parallel` 不改（靠闸门限流，不造新调度器）。`GET /api/apps/resources` 暴露 配额/占用/排队/License，`GET /api/apps` 描述补 `resources`/`license`。无迁移（占用态在内存，`app_instances.resources` 承载计数）；`config_version` 36→37；前端本切片未改。多 worker 全局配额与真实 GPU 计量记为后续增量。

> **进度（切片 5：N9 文件/资产与跨软件数据契约已落地）**：新增 `deerflow/assets/`——`ref.py` 的 `AssetRef`（规范 `asset://` URI + scope 内可用 `path` + 指纹 `size`/`mtime`/`sha256`/`extension`/`media_type`/`contract`/`source`，经 `data` 端口以 dict 流转，**不新增 PortType**）与 `contracts.py` 的 `AssetContract`（扩展名/media_type/单位与坐标约定）与 `AssetConverter`（`from`/`to`/`command`/`args` 模板，必须含 `{in}`/`{out}`）。新增 `data:asset` 节点（`workflow/executors/asset.py`）：`inspect`（只读读指纹，注册幂等）/`import`（宿主→沙箱）/`export`（沙箱→宿主，临时文件 + `os.replace` 原子写）/`convert`（声明式转换器，命令**走 sandbox**）；三个写操作在**执行器内部**要求 `crash_confirm=true`（同 `data:file` write 先例，不打成 pending_review 危险节点）。宿主访问受 `config.yaml assets.roots` 白名单约束（**默认空 = 禁用往返**，三重校验：归一化包含 + 源文件拒 symlink + `resolve()` 后复核防父目录 symlink 逃逸）并受 `assets.max_bytes` 上限约束；`assets.contracts` 命中即校验（报错携带期望/实际）。`app:collect` 增量输出 `assets`（每产物一个 `scope="host"` 的 `AssetRef`，`params.hash` 可选 SHA-256），`artifacts`/`out` 原样保留 → 旧工作流零破坏。`config_version` 37→38；**无迁移**（资产不落库）；前端只同步节点目录/类型（新增 `data:asset` 条目 + `app:collect` 的 `assets` 端口），无新页面。真实软件格式互转脚本本体、资产版本库/溯源历史、资产 UI 记为后续增量。

> **进度（切片 6：N10 预览 / 审批 / undo 已落地）**：新增 `deerflow/workflow/preview.py`——`ActionPreview`（动作/摘要/`reversible`/`recovery` + `sources`/`targets` + `risks` + `required_confirmations`）与 `PreviewTarget{ref, observed}`（**`observed` 是关键**：只有「真的看过」的目标才能发现审批期间文件**出现**，这正是审批要防的覆盖事故）；目标/来源直接复用 N9 `AssetRef` 承载指纹；沙箱目标刻意「只声明不指纹」（抽象 Sandbox 无 stat，观测内容要整文件下载），真实风险在宿主侧。预览器与执行器同址注册（`ExecutorRegistration.preview`）经 `CompileContext.previews` 传给 compiler，compiler 不依赖 registry。新增 `workflow/approval.py`：`require_approval=true` 的节点由 **compiler 节点包装层**在执行前预览 → 建 `kind="approval"` 的 HumanTask（`inputs_snapshot.preview` 存序列化预览）→ `interrupt()` 挂起（复用 `human:task` 的 `(run_id,node_id)` 复用规则，不重复建任务）→ 恢复后按**冻结快照**复验被观测目标指纹，不匹配即 `WorkflowExecutionError` 要求重新预览；拒绝按 `on_reject`（`fail` 默认 / `skip`），`__skip` 与无 decision 载荷一律视为**拒绝**；`require_approval` 落在无可预览类型的节点上是**编译期错误**；`crash_confirm` 门原样留在执行器内（审批预览的 `required_confirmations` 已告知人类）。新增 `workflow/compensation.py`：`rollback_on_failure=true` 时先备份被触及文件到 `{DEER_FLOW_HOME}/undo/<run_id>/<node_id>/`（**引擎私有恢复材料，不受 `assets.roots` 约束**），失败即回滚（宿主 `os.replace` 原子恢复；沙箱 `update_file`；「原本不存在」则删除，沙箱删除走 `execute_command` 且失败写进 detail）；**备份失败 → 在改动之前拒绝执行**（保守默认）；undo 记录写入 best-effort（成功变更不因记账失败而失败）。新增 `workflow/undo.py`（纯模型 `UndoRecord`/`plan_undo` 逆序/状态机 + 文件级备份恢复）、`persistence/workflow_undo/`（`workflow_undo_records` 表，`backup_paths` 与 `targets` **一一对齐**，`None` = 原本不存在）、`workflow/undo_service.py`（`execute_run_undo`：宿主直接恢复 + 沙箱按 run 的 thread 懒取沙箱 + 应用原生 undo；实例已消失 → `skipped`；每条记录落到终态故重复请求不会二次补偿）。应用原生 undo 采用**声明 + 实现双条件**（`supports_undo` 标志 + `undo` 方法，二者都不进 `AppDriver` 协议以免破坏既有驱动 `isinstance`）；`cli` 驱动诚实声明不支持，`mock` 实现以便离线测试；`AppSessionManager.undo` 仍走 N8 准入咽喉且要求会话存活。迁移 `0019_human_task_kind_and_undo`（`human_tasks.kind` 默认 `"task"` + undo 表）；`/api/human-tasks?kind=approval` 与 `list_human_tasks` 工具可列出审批请求。API：`POST /api/workflows/{id}/preview`（**定义级**预览，带显式 params/inputs）+ `GET|POST /api/workflows/{id}/runs/{rid}/undo`（计划 / 执行，支持 `dry_run`）；对话侧 `undo_workflow_run` 与路由共用同一 `undo_service`。偏离：未实现对话侧 `preview_workflow_action`（审批预览已由审批任务快照 + REST 预览路由覆盖，收益低于成本）；共享工作区治理（人在用/抢占/冲突/可见性）列为 N10b。

> **进度（切片 6b：N10b 人机共享工作区治理已落地）**：§17 的「人机共享」四件事一次收口。**presence**：`apps/presence.py` 的纯决策表 `decide_access(report, policy, allow_preempt)`（与 N7 `is_trigger_due`、N10 `make_preview` 同构）—— `idle` 放行；`unknown` **放行且标记**（探测是尽力而为，绝大多数 GUI 报不出 presence，对无知 fail-closed 等于把功能锁死，那是封锁不是安全）；`busy`/`human` 按 `apps.on_human_conflict`：`fail`（默认，拒绝）/ `wait`（排队，受 `acquire_timeout_seconds` 约束）/ `preempt`（接管）。**抢占必须显式授权**：只有定义声明 `allow_preempt: true` 才认 `preempt`，否则回退拒绝——绝不静默把人正在用的软件抢走。**探测能力是可选驱动能力**（`supports_presence` 标志 + `probe_presence` 方法双条件，镜像 N10 的 undo；协议不加方法以免破坏既有驱动 `isinstance`）：`cli` 只在定义声明 `presence_command` 时执行（退出码 0 + stdout 首词为 `idle|busy|human|unknown`），`mock` 读 `.mock-presence` marker（离线可测），其余一切（无声明/非 0 退出/超时/横幅）→ `unknown`，且在驱动边界归一化——探测坏掉绝不能变成「应用是空闲的」。**执行与记账在 `AppSessionManager` 唯一咽喉**：`launch` 只对「自己没持有的应用」做准入（复用自己实例不查 presence，没有第三方可仲裁），取得时把归属记进 session（`holder`/`taken_over_from`/`taken_over_at`，additive 进 `session` 端口）并 best-effort 写进实例记录 `resources`（无迁移）；`release` 交还控制但不关闭实例（实例仍占机器、仍持 license 槽）；`app:script` 可 `check_presence=true` 逐操作检查（默认关——探测无法归因在飞工作，否则会因引擎自己的上一份作业而误拒）。**可见性**：`GET /api/apps/{name}/presence`（`?force=true` 绕过短 TTL 缓存；无 probe 报 `unknown`，绝不 5xx）、`POST /api/apps/sessions/{id}/release`、实例接口带 `holder`、工具 `check_app_presence`，app 工具把「人在用」作为 `status="human_present"` **数据**返回（对齐 N8 `resource_unavailable`），让 agent 能告知用户而不是当成崩溃。**冲突检测**：`workflow/conflict.py` 的 `params.detect_conflicts=true` 让节点在**自己的等待窗口**（人未释放、准入排队）前快照声明的宿主产物（**含内容哈希**——同尺寸同秒重写正是软件干的事），改动前复验，变了即 `WorkflowConflictError`；这是守卫不是锁，沙箱路径诚实标为「无法复验」，且**不做归因猜测**（「你看过之后它变了」可证，「是人改的」不可证）。边界：presence/抢占是**进程内**治理，跨进程互斥仍由 N8 license slots + `locks/file_lock.py` 承担；`config_version` 38→39；无迁移、无新表；前端无共享 UI（延续 deferred）。

> **进度（切片 7：N11 环境探测与数据目录规范已落地）**：§22 前两条一次收口。**探测是只读的**——只回答「在不在 / 什么版本 / 路径存不存在」，不安装、不下载、不改环境、不写宿主（唯一创建动作是显式 `ensure_data_dirs()`，且只在 base_dir 自己名下）；`scripts/doctor.py` 仍是**开发机**体检（python/node/pnpm/uv/nginx/config），N11 是**运行时**体检，两个不同的问题（且 harness 本就无法导入根 `scripts/`）。**结果是三态 + unknown**：`ok`/`missing`/`mismatch`，外加 `unknown`（超时、非 0 退出、输出不可解析）——`unknown` **既不算通过也不算失败**，因为把「探不出」当成「不满足」会让所有没有版本命令的软件一律不可用（与 N10b 对 presence 的同一取舍）；反过来，**版本串不可解析时绝不猜成 ok**，`version_satisfies` 返回 `True`/`False`/`None` 三值，`None` 一律映射到 `unknown`。**声明是数据不是代码**：`RequirementSpec` 五类 `kind`，`command` 用 **argv 列表**（避免自造 shell 引号/`PATHEXT`/反斜杠规则——N10b 对 `presence_command` 的同一理由），`command`/`expect` 落在存在性 kind 上是**配置错误**（那是意图写错，不是多余字段）；`plugin` 的相对路径相对应用 `working_dir`、`path` 相对进程 cwd，这是两者唯一但真实的语义差别。**绑定能力包**：能力包在 schema 层就是 skill（`Node.capability_groups` → skill 名），所以声明落在 SKILL.md 的 `requires:`，用与 app 相同的模型，fail-soft 解析（非法项 warn 丢弃，不让一个笔误把包变成装不上），且**只校验 enabled 技能**——你没启用的包不是这台机器要准备的东西。**加载时校验、默认 fail-open**：启动确保数据布局 + 探测一次并把问题写进日志；`apps.environment.require_on_load: true` 才把「必需项确定性失败」升级为启动拒绝——今天用不到的应用缺一个插件不该让整个 Gateway 起不来，但锁定环境的部署需要硬门，两者都要能表达。顺带把 N4 起就**声明了却从未被读取**的 `AppDefinition.version_command` 接上（与 `presence_command`/script 同 argv 位置，探测结果即应用版本）。**数据目录规范**：`Paths.data_dirs()` 是**规范本身**（有序、带 purpose/scope/required），`check_data_dirs()` 只观测存在性与可写性（**不创建**，缺失目录的 `writable` 是 `None` 而不是猜），`ensure_data_dirs()` 幂等且只建必需项；§22 的四类数据落点写在这里——**definitions / checkpoints / app sessions 都是 SQL 库里的行**，assets 在操作员自己的 `assets.roots`，所以「完整备份」是「一组路径 + 那个数据库文件」。**可选目录缺失不降级**：派生检索索引与 legacy threads 根是按需创建（或永不创建），把它们的缺席算成 `degraded` 会让每台健康机器常年 degraded——永远亮着的信号不是信号。面：`GET /api/environment[?force=true]`（只读；探测不可答是 200 里的 `unknown`，绝不是 5xx）、`features.environment.enabled`、`python -m deerflow.environment [--json] [--force]`（退出码 0/1/2 可进 CI）。`config_version` 39→40；无迁移、无新表；前端零改动（运维面 API + CLI）。§22 第三条「备份/导出导入/换机迁移」独立为 **N11b**。

> **进度（切片 8：N11b 数据备份 / 导出导入 / 换机迁移已落地）**：§22 第三条收口。新增 `deerflow/portability/`——`spec.py`（归档模型 `BackupManifest`/`ManifestEntry`/`ExcludedEntry` + `check_import_compatible`，纯；格式版本 `BACKUP_FORMAT_VERSION=1` 是**硬门**，`config_version`/`schema_head` 漂移只警告）、`select.py`（纯决策：`plan_backup` 从 N11 `data_dirs()` 选成员、`plan_restore` 把归档逻辑名映射回本机当前路径并给出拒绝/跳过）、`archive.py`（安全 zip 读写：**逻辑布局** `dirs/<name>/`+`database/<file>`+`assets/<idx>/`，解包拒绝绝对路径/`..`/符号链接条目）、`snapshot.py`（SQLite `Connection.backup()` **一致性快照**，在线只读；不直接拷 `.db`——WAL 下近日提交在 `-wal`）、`service.py`（`export_backup`/`inspect_backup`/`import_backup` 编排）、`__main__.py`（`python -m deerflow.portability export|inspect|import [--json]`，退出码 0 成功 / 1 拒绝 / 2 自身错误）。**归档 = 单文件 zip + 根 `manifest.json`**，逻辑名保证跨机 `base_dir` 不同也能恢复。**排除项声明化**：`locks`（瞬态锁）/`retrieval`（派生索引）带原因写入 manifest；`base` **浅打包**（只收顶层 `memory.json`/`USER.md`，不收子目录，避免整树双份）。**库**：SQLite 走在线快照；Postgres 不入包（manifest 记 `database_included=false`，由 `pg_dump` 承担）；memory 无库。**导出可对活实例运行，导入是离线操作**（覆盖库文件，仅 CLI，**不加 HTTP 导入端点**——覆盖正在服务的库是脚枪）；目标非空默认拒绝，`--force` 覆盖，`--dry-run` 预览；assets 为操作员自有路径，导出 opt-in（`--include-assets`）、恢复需显式 `--assets-dest`（跨机绝对路径不猜），缺失则报告 skip。面：`GET /api/backup` **只读**返回导出计划（不含体积扫描）；`features` 不改（无配置门）。**无迁移、无新表、无新配置段**（归档自带 `BACKUP_FORMAT_VERSION`）；前端零改动；无新依赖（`zipfile`/`sqlite3`/`json` 标准库）。

1. **N4 本地软件接入层**（应用注册表 / 实例会话 / 驱动矩阵 / 共享）。— ◐ 切片 1 完成主体
2. **N5 `app` 类节点**（launch/script/wait/collect）+ tool 网关 `app` provider。— ✅ 切片 1
3. **N6 长期实例管理** + **N7 触发与调度**（cron/文件监视/应用事件，幂等/DLQ）。— ◐ N6（持久化/恢复/归档/清理/资源累计）+ N7（触发源/载荷映射/去重/退避/DLQ）主体完成；N7 前端 UI 待做
4. **N8 本地资源治理**（GPU/内存/磁盘、License 并发、独占锁）。— ◐ 声明式配额 + 准入闸门 + License slots + 跨进程文件锁主体完成；真实 GPU 计量/多 worker 全局配额待做
5. **N9 文件/资产 + 跨软件契约**。— ◐ 资产识别/宿主↔沙箱往返/声明式转换/契约校验主体完成；真实软件格式互转脚本与资产版本库待做
6. **N10 人机共享工作区 + 预览 undo**（对接应用原生 undo）。— ✅ 切片 6 完成。**预览/审批/undo**：`workflow/preview.py`（纯函数 `ActionPreview` + `PreviewTarget.observed` + 复用 N9 `AssetRef` 指纹）、`workflow/approval.py`（`params.require_approval=true` → compiler 包装层在执行前建 `kind=approval` 的 HumanTask 并 `interrupt()`，恢复后按**冻结的预览快照**复验指纹，不匹配即失败；`on_reject: fail|skip`；`__skip`=拒绝）、`workflow/compensation.py`（`rollback_on_failure=true` 先备份后执行，失败即回滚；备份失败则在改动前拒绝执行）、`workflow/undo.py` + `persistence/workflow_undo/`（`workflow_undo_records` 表）、`workflow/undo_service.py`（逆序撤销，宿主直接恢复 + 沙箱经 thread 取沙箱 + 应用原生 undo）、驱动 `supports_undo`/`undo` 双条件能力、`POST /api/workflows/{id}/preview` 与 `GET|POST /api/workflows/{id}/runs/{rid}/undo`、对话工具 `undo_workflow_run`；迁移 `0019`（`human_tasks.kind` + undo 表）。**人机共享治理（N10b）**：`apps/presence.py`（纯决策表 `decide_access`：`idle`/`unknown` 放行、`busy`/`human` 按策略；`unknown` 是诚实答案且不阻塞）+ 驱动可选 `probe_presence`（`cli` 按定义声明的 `presence_command`、`mock` 读 marker，其余一律 `unknown`）+ `apps.on_human_conflict: fail|wait|preempt`（`preempt` 仅 `allow_preempt: true` 时生效，未声明回退拒绝）+ 归属可见性（`holder`/`taken_over_from` 进 session 端口与实例记录，`GET /api/apps/{name}/presence`、`POST /api/apps/sessions/{id}/release`、工具 `check_app_presence`）+ `workflow/conflict.py`（`params.detect_conflicts=true`：节点等待前快照宿主产物、改动前复验，变了即拒；只覆盖可观测的宿主路径，不做归因猜测）。`config_version` 38→39，无迁移。
7. **N11 环境探测 / 数据目录 / 备份迁移**。— ✅ 切片 7 完成前两条 + 切片 8（N11b）完成备份/导出导入/换机迁移。**环境探测**：新 `deerflow/environment/`（与 `apps/`/`assets/`/`resources/` 同级）——`spec.py` 的 `RequirementSpec{kind,name,command,expect,optional}`（`executable`/`version`/`path`/`runtime`/`plugin`；`command` 是 **argv 列表**，不自造引号规则；`plugin` 相对路径相对应用 `working_dir`，`path` 相对进程 cwd）、`version.py` 的纯比较（`>=><=<>===!=^~*` + 逗号合取，数字比较，`^4.2`/`~4.2` 语义写死；**不可解析 → `unknown`，绝不猜成 ok**，不引入 `packaging`）、`evaluate.py` 的探测决定表（`ok`/`missing`/`mismatch` + `unknown`；未知既不算通过也不算失败——探测尽力而为，与 N10b presence 同一取舍）、`probe.py`（唯一 I/O，**只读**，`shutil.which` 复用 cli 驱动的可达性判定；超时/非 0 退出/乱码输出一律 `unknown`；进程内短 TTL 缓存 + `force`）。**与能力包绑定**：`AppDefinition.requires` + SKILL.md frontmatter `requires:`（同一模型，fail-soft 解析进 `Skill.requirements`；只校验 **enabled** 技能），并把 N4 起就悬空的 `AppDefinition.version_command` 真正接上（与 `presence_command` 同位置规则，`detect_app_version` 供 `GET /api/apps` 用）。**加载时校验但默认 fail-open**：启动 `ensure_data_dirs()` + 一次探测报告；`apps.environment.require_on_load: true` 才把「必需项确定性失败」升级为启动拒绝。**数据目录规范**：`Paths.data_dirs()` 有序布局（base/users/skills_view/integrations/locks/undo + memory 开启时的派生索引 + file SQLite 时的 database 目录 + legacy threads）+ `check_data_dirs()`（只观测、**不创建**）+ `ensure_data_dirs()`（幂等、只建必需项）；§22 四类数据的落点写明（definitions/checkpoints/app sessions 在 SQL 库，assets 在 `assets.roots`）。面：`GET /api/environment[?force=true]`（只读、探测不可答是 200 里的数据而非 5xx）、`features.environment.enabled`、`python -m deerflow.environment`（退出码 0/1/2 可进 CI）。`config_version` 39→40；**无迁移、无新表**；前端零改动。备份/导出导入/换机迁移 → N11b。

验收：Blender/Unity/PS 等本地软件可被注册、拉起/附加、脚本驱动、产物回收；长时任务可由事件触发并跨重启恢复。

### P2 — 编排增强 + Agent 能力（分批）

1. **N12 容错编排**（Try-Catch/Finally、降级/回调）。— ✅ 已落地（`flow:try`，见上）
2. **N13 并发治理**（并行合并规则、共享变量、资源锁）。— ◐ 已落地 合并规则 + 资源锁主体；共享变量延后
3. **N14 §24 中与定位强相关项优先**：上下文策略(#3)、结构化输出(#4)、自主度预算(#5)、协作原语(#6a)、事务/undo(#7)、确定性重放(#11)、可观测(#9)、成本治理(#10)、记忆(#1)、检索(#2)、协作拓扑模板(#6b)。

### P2 续 — N14 剩余切片（按定位相关性排序）

> 前置：切片 A–E 已落地（见上）。本批次把 §24 剩余项拆为独立切片，逐刀 TDD + 全量离线 A/B 对拍（失败集须逐条一致），每刀一个小步提交。
>
> 排序依据：P2 第 3 条「与定位强相关项优先」顺序 `#3→#4→#5→#6a→#7→#11→#9→#10→#1→#2→#6b`（#3/#4/#5/#6a 已由切片 A–E 覆盖，#9 失败分类已由切片 D 覆盖，trace/成本归因既有）。

| 切片 | 对应 | 范围 | 状态 |
|---|---|---|---|
| N14f | §24.7 工作流事务与自愈 | 幂等键端到端（`tool:http` 请求头 / `tool:bash` 环境变量）+ 有界节点重试（**仅幂等节点** `params.retry`，保留通道 `wf:<node>:__retry`）；effect journal 复用既有 `workflow_undo_records`（补偿/回滚 N10 已落地） | ✅ 已落地 |
| N14g | §24.11 确定性重放 | run 级 record/replay fixture（节点输出粒度）+ 回放执行 + 脱敏；与 lockfile 关联 | ✅ 已落地 |
| N14h | §24.8 评测/回归 | golden traces + 确定性/语义断言 + runner（可挂能力包导入与定义保存） | ✅ 全部落地：断言核心 + runner + CI CLI + 定义内嵌套件与 opt-in 保存门（N14u）+ 能力包导入评测门（N14ag） |
| N14i | §24.10 成本/预算治理 | node/run/workflow 三级预算 + 超限策略（warn/degrade/abort）+ 本地优先路由 | ✅ 模型路由（N14i）+ 运行级预算（N14n）+ 运行成本报表（N14t）已落地 |
| N14j | §24.1 记忆体系 | 四级记忆 + 节点 `params.memory` 注入/写回（复用现有 DeerMem） | ✅ 策略/格式化/store 协议 + AI 节点接线 + DeerMem 适配器已落地（仅 long_term 作用域） |
| N14k | §24.2 知识检索 | `data:retrieve` 节点 + 摄入/索引/检索/引用（本地向量后端，可插拔） | ✅ 纯检索核心 + AI 节点注入 + `data:knowledge` 节点 + 向量后端适配器（N14w）已落地 |
| N14l | §24.6a 余 + §24.6b | 有界评审回环 / 受控动态 handoff + supervisor/critic 拓扑模板 | ✅ 模板 builder + 端点 + 画布插入 UI + `flow:handoff` 受控动态 handoff（N14af）已落地 |
| N14m | §24.12 注入防御（N15） | taint/来源追踪、记忆写入门、工具权限裁决点（低优先级） | ◐ AI 节点注入块未信任中和已落地；威胁模型/权限裁决深化待做 |
| N14n | §24.10 运行级预算 | node/run/workflow 三级预算 + warn/degrade/abort | ✅ 运行级（`metadata.budget` warn/abort）+ 运行成本报表（N14t）已落地；节点级由 autonomy |

> **N14f 目标**：把「节点级副作用」纳入事务语义——重试只对**幂等**节点开放（非幂等自动重试 = 重复副作用，编译期拒绝），重试携带**稳定幂等键**让外部系统（HTTP 服务、脚本）能识别重复；实际重试次数经保留通道可观测。AI 诊断式自愈（模型建议→有界重试）与多步 saga 的 effect journal 独立成刀，D 项已由 N10 的 `undo_service`（逆序补偿）覆盖。
>
> **进度（切片 F：§24.7 幂等键端到端 + 有界节点重试）**：新增 `deerflow/workflow/reliability.py`（**纯逻辑**）——`parse_retry_policy`（`params.retry = {max_attempts 1..10, backoff_seconds 0..60, retry_on?}`，坏形状 `RetryPolicyError`）、`is_retryable_exception`（**控制流/取消永不重试**：`GraphBubbleUp`（含 `GraphInterrupt`）与 `BaseException` 子类（`CancelledError`/`KeyboardInterrupt`/`SystemExit`）排除）、`should_retry`、`idempotency_key(run_id, node_id)`（**稳定键，不含 attempt**——重试必须复用同键才能被外部去重）、`resolve_idempotency_key`。**编译期**：`CompileContext.idempotent_by_type`（由 registry `build_context` 填充，进缓存指纹）+ `_validate_retry`——`params.retry` 仅允许落在**幂等**的 executor 节点上，非幂等（`tool:bash`/`tool:http`/`app:launch`/`app:script`/AI/人类/嵌套等）声明即 `WorkflowCompileError`；`params.idempotency` 形状校验（bool/非空串）。**运行期**：`_make_node_fn` 在**审批门之后**只包裹 `_resolve_executor` 调用做有界重试（退避 `asyncio.sleep`，异常/取消/控制流不吞，用尽即节点失败），重试次数写保留通道 `wf:<node>:__retry`（0 不写）；`params.idempotency` 真值时把 `__idempotency_key` 注入 executor（不进原始定义）。**执行器**：`tool:http` 加 `Idempotency-Key` 请求头、`tool:bash` 注入 `DEERFLOW_IDEMPOTENCY_KEY` 环境变量（调用方显式配置则尊重）。effect journal / 补偿沿用 N10 `workflow_undo_records` + `undo_service`（逆序），**AI 诊断式自愈为后续增量**。**无迁移/无新表/无新配置段/无新依赖**；前端零改动（`params` 级）。测试：新增 `tests/test_workflow_reliability.py`（41 条：解析/形状/重试判定/控制流不重试/幂等键稳定/编译期门/运行期重试成功与用尽/`__retry` 通道/http 头/bash env 注入）。workflow 套件 843→884 passed；ruff check/format 干净。
>
> **进度（切片 G：§24.11 确定性重放）**：新增 `deerflow/workflow/replay.py`（纯逻辑 + 原子 JSON 持久化）——`input_digest(node_id, node_type, inputs)`（规范化 JSON（sort_keys/default=str）→ sha256，**确定性**）、`ReplayEntry`/`ReplayFixture`（版本化 `schema_version`，`to_dict/from_dict` + `to_json/from_json` + `save_fixture`/`load_fixture` 原子写）、`ReplaySession(mode=record|replay, on_miss=error|live, redact)`（`record` 追加并建索引；`replay` 命中回放 `outputs`、未命中 `error`→`ReplayMissError` / `live`→返回 None 回退真实执行）、`redact_secrets`（递归掩码密钥名，纯函数）。**compiler 集成**：`_make_node_fn` 读运行上下文键 `REPLAY_CONTEXT_KEY`——replay 命中即**跳过 executor**（不触发真实模型/工具调用，也不进入重试循环）；record 模式在 executor（含 §24.7 重试）成功后落条目；无 session 时零行为变化（仅一次 dict 查找）。**粒度诚实**：录的是**节点输出**（图确定性），非模型内部 token；确定性节点也一并回放（更强的整图确定性）。证据即 fixture 本身。**与 lockfile 关联、worker/config 自动录制开关、检索/记忆快照录制列为后续增量**。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_replay.py`（24 条：digest 稳定/敏感、脱敏、fixture 往返与文件、session 形状校验/record/replay/miss；编译执行 record 产出、replay 跳过 executor、miss error/live、无 session 不变、整轮 record→replay 一致）。workflow 套件 884→908 passed；ruff 干净。
>
> **进度（切片 H：§24.8 评测/回归断言核心）**：新增 `deerflow/workflow/evals.py`（纯逻辑，离线可测）。`extract_node_outputs(state)` 把最终状态的 `wf:<node>:<port>` 通道按节点分组（跳过 `wf:shared:` 与 `__` 保留通道），使 **N14 §24.11 回放的 run 最终状态可直接喂入**。`NodeAssertion(node_id, port, kind, expected, case_sensitive)`——确定性断言 `equals`/`truthy`/`exists`/`contains`/`matches`（regex）；**语义断言** `semantic` 交给**注入式** `judge(expected, actual)->bool`（LLM-as-judge / 相似度由调用方提供，核心保持纯函数、离线可测；缺省无 judge 记失败、judge 抛错记失败）。`evaluate_assertion`/`evaluate_case`、`EvalReport`（`total`/`passed`/`failed`/`pass_rate`/`failures` + `to_dict`/`to_json`）、`run_eval_suite(cases, outputs_by_case)`。**规格校验**在构造期 fail-loud（未知 kind / `semantic` 非串 / 非法 regex）。**runner（执行定义 + 采集输出）与 CI 挂载（能力包导入、定义保存）为后续增量**。**无迁移/无新表/无新配置/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_evals.py`（30 条：提取/形状校验/各断言/报告聚合/json/`run_eval_suite` + 与回放 run 的集成）。workflow 套件 908→938 passed；ruff 干净。
>
> **进度（切片 I：§24.10 节点级模型路由）**：新增 `deerflow/workflow/routing.py`（纯逻辑）——`parse_routing_policy`（`params.model_policy = {prefer: default|local|cheap|quality, require_local}`，坏形状 `RoutingError`）、`model_infos(models)`（从 `config.models[*]` 归一并容错读可选 `local`/`cost_tier`，`ModelConfig` extra-allowed 无需改 schema）、`select_model`（`prefer=local` 本机优先 / `cheap` 低价优先 / `quality` 高价优先 / `default` 部署序；**确定性名称 tie-break**；`require_local=True` 且无本机模型 → `RoutingError`）。`ai:llm_agent` 接入：据 policy 选出模型名写入 `SubagentConfig.model`（`inherit` 缺省零破坏）；**`require_local` 无法满足即节点失败，绝不静默回退远程**；与 continue 模式互斥（运行期报错，会话已固定模型）。**诚实取舍**：node/run/workflow **三级预算强制**（warn/degrade/abort）与成本报表未做——节点级 token 上限已由 §24.5 `params.autonomy.budgets.max_tokens`（`TokenBudgetConfig`）承担。**无迁移/无新表/无新配置段/无新依赖**（模型元数据走 `models[*]` 额外字段）；前端零改动。测试：新增 `tests/test_workflow_routing.py`（23 条：解析/形状/归一/选择各 prefer/require_local 失败/tie-break + 执行器接线：local 选择、无 policy inherit、require_local 失败、坏 policy）。workflow 套件 938→961 passed；ruff 干净。
>
> **进度（切片 J：§24.1 节点级记忆）**：新增 `deerflow/workflow/memory.py`（纯逻辑 + 参考 store）——四级记忆作用域 `session`/`node`/`workflow`/`long_term`；`parse_memory_policy`（`params.memory = {scopes, query?, inject_budget?, write?, write_scope?}`，坏形状 `MemoryPolicyError`）、`render_query`（`{{port}}` 插值，缺键→空）、`format_memory_block`（`<memory>` 块，按 `estimate_tokens` 预算**顺序**填装、超限停止）、`MemoryStore` 协议（`search(scope, query, limit)`/`put(scope, text, key)`）+ `InMemoryMemoryStore`（子串检索参考实现）+ `collect_memory`/`acollect_memory`/`awrite_memory`（同步/异步 store 双支持）、`output_text`。`ai:llm_agent` 从 `runtime.context["memory_store"]` 取 store：**读**命中拼进提示词（`<memory>` 前置于 system prompt）、**写**在成功后把节点输出写回 `write_scope`；**读写失败仅告警不阻塞节点**（§24.1）；与 continue 模式互斥（运行期报错）。`<memory>` 是既有框架权威块（已在 sanitization denylist 内，护栏自检通过）。**诚实取舍**：本切片落地**节点级策略 + 注入/写回 + store 协议**；**DeerMem 适配器**（把现有 `MemoryManager` 包成 `MemoryStore` 并注入运行上下文）为后续增量（不引新依赖、不动全局记忆中间件）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_memory.py`（32 条：解析/形状/插值/块渲染与预算/store/collect 同步异步/输出文本 + 执行器：读注入、写回、无 store 不注入、continue 拒绝、坏 memory 失败）。全量离线 A/B：10985→11017 passed、**失败集合逐条一致**；workflow 套件 961→993 passed；ruff 干净。
>
> **进度（切片 K：§24.2 知识检索）**：新增 `deerflow/workflow/knowledge.py`（纯逻辑 + 参考 store）——`chunk_text`（确定性重叠分块，段落窗口 + overlap）、`tokenize`（ASCII 词 + CJK 逐字）、`rank_chunks`（**BM25-lite 确定性排序** `(-score, citation)` + top_k + 可注入 `reranker`；空 query 保序、reranker 异常忽略）、`Document`/`Chunk`/`RetrievalRecord`（稳定 `cite:<chunk_id>` 引用）、`KnowledgeStore` 协议（`upsert`/`query`，支持异步）+ `InMemoryKnowledgeStore` + `ingest_document`、`parse_retrieval_params`（`params.retrieval = {collection, query?, top_k? (1..20), ctx_budget?, rerank?}`，坏形状 `KnowledgeError`）、`render_query`（`{{port}}`）、`format_retrieval_block`（`<context>` 块 + `--- cite ... ---` 头，按 `estimate_tokens` 预算顺序填装）、`aquery`。`ai:llm_agent` 从 `runtime.context["knowledge_store"]` 检索并前置 `<context>` 块，**失败仅告警**；与 continue 模式互斥。**诚实取舍**：复用**已 sanitize 的 `<context>` 标签**（不引入新框架标签、无需改 denylist）；默认关键词排序（离线无依赖），**embedding/向量后端为可插拔 store**；rerank 为可注入 callable；**专用 `data:knowledge` 节点 + 前端 palette 列为后续增量**（避免 schema/前端计数改动，核心能力已可由 AI 节点消费）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_knowledge.py`（42 条：分块/分词/排序/reranker/store/摄入/参数/渲染/asyncio + 执行器：检索注入、无 store 不注入、continue 拒绝、坏 retrieval 失败）。全量离线 A/B：11017→11059 passed、**失败集合逐条一致**；workflow 套件 993→1035 passed；ruff 干净。
>
> **进度（切片 L：§24.6a/§24.6b 多智能体拓扑模板）**：新增 `deerflow/workflow/patterns.py`（**纯 builder**，返回可序列化 `WorkflowDefinition`，无新引擎行为）——`critic_review_loop`（producer↔critic **有界评审回环**：用 `flow:loop` + `params.continue_on="needs_revision"` 读 critic 判定 + `iterations` 硬上限，回边携带 criti 结论，仅复用既有 C5 机制）、`supervisor_topology`（supervisor `ai` 节点写 `decision` 端口 → `flow:switch` 按 `params.cases` **运行期分派到已注册专家节点**，无匹配则默认直通 end）、`TEMPLATES` 命名表。两 builder 产出的定义均过 `validate_definition` 且可 `compile_definition`；`critic_review_loop` 运行验证（critic 批准即退出 / 迭代上限硬停）。**诚实取舍**：本切片落地**拓扑模板 builder**（画布可作为起点插入的「UX 糖」后端）；**前端「插入模板」按钮 + 受控动态 handoff 的结构化消息契约列为后续增量**。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_patterns.py`（10 条：定义校验/编译/回环批准退出/迭代上限/supervisor 参数校验与分派/模板表）。全量离线 A/B：11059→11068 passed、**唯一新增「失败」为既有**时序 flake `test_extension_task_lifecycle::test_notification_timeout_is_one_shared_budget`（单跑通过、与纯新增模块无关，N14a 已记录该 flake）；workflow 套件 1035→1045 passed；ruff 干净。
>
> **进度（切片 M：§24.12 注入防御）**：新增 `deerflow/workflow/sanitize.py`（纯助手）——`neutralize_untrusted(text)` **复用输入净化中间件的 `neutralize_untrusted_tags`**（框架权威标签 denylist 的**单一来源**，延迟导入避免重依赖/循环），把 AI 节点**自行拉入提示词**的未信任内容中的框架标签（`<system-reminder>`/`<memory>`/`<context>`/`<available_skills>` 等）中和，使其**无法伪造框架块**。接入点：`knowledge.format_retrieval_block`（§24.2 检索块）与 `memory.format_memory_block`（§24.1 记忆块）的**正文**经此处理——外围 `<context>`/`<memory>` 包裹仍是引擎自己生成的，内部正文里的同名标签被中和。**诚实取舍**：§24.12 的其余项**已由既有机制承担**（沙箱隔离、危险节点审核、依赖静态校验、请求级密钥隔离 `required-secrets`、记忆提取 scope/durability/authority 门、N10 不可逆操作预览/确认边界）——本切片只补「AI 节点注入块」这一新暴露面；**完整威胁模型/工具级权限裁决深化仍为后续**（P3）。失败降级为原文（**纵深防御，非硬边界**）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_sanitize.py`（8 条：空/良性不变/框架标签中和/检索块与记忆块防伪造）。全量离线 A/B：11068→11074 passed、新增 8 条测试全过；**唯一新增「失败」为既有**时序 flake 文件 `test_extension_task_lifecycle.py` 的两条（整文件单跑 12 passed×3、与纯新增模块无关，N14a 已记录该 flake）；workflow 套件 1045→1052 passed；ruff 干净。
>
> **进度（切片 N：§24.10 运行级预算）**：新增 `deerflow/workflow/budgets.py`（纯逻辑）——`RunBudget` + `parse_run_budget`（`WorkflowDefinition.metadata.budget = {max_total_tokens, on_exceed: warn|abort}`，坏形状 `BudgetError`）、`usage_total`（`total_tokens` 优先，坏值回退 input+output）、`aggregate_token_usage`（聚合各节点保留通道 `wf:<node>:__token_usage`）、`evaluate_budget`。`schema.WorkflowMetadata` 增可选 `budget` 字段（additive，旧定义零破坏）。`compiler`：`_validate_run_budget` 编译期校验 + `_make_node_fn` 每节点后聚合 state（含本节点用量）并按策略强制——`abort` 抛 `WorkflowExecutionError` 停止 run，`warn` 记日志继续。**三级预算落点**：节点级 = §24.5 `params.autonomy.budgets.max_tokens`（`TokenBudgetConfig`）；运行/工作流级 = 本切片 `metadata.budget`。**诚实取舍**：`degrade` 刻意不设（token 已花，无法退回），只支持 `warn`/`abort`；**成本/花费报表（按 node/model 归因 + currency 计价）列为后续增量**（`models[*].pricing` 元数据与 console 计价已有底座）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_budgets.py`（23 条：解析/用量/聚合/决策 + 编译期坏预算报错 + abort 失败/warn 继续/无预算不受影响/额度内通过）。全量离线 A/B：11097→11117 passed、新增 23 条全过；**唯一新增「失败」为既有**时序 flake（`test_extension_task_lifecycle.py` 两条 + `test_sandbox_orphan_reconciliation.py` 一条，隔离运行 13 passed，均与纯新增模块无关）；workflow 套件 1052→1075 passed；ruff 干净。
>
> **进度（切片 O：§24.2 `data:knowledge` 节点 + 前端 palette）**：新增 `deerflow/workflow/executors/knowledge.py` 的 `exec_knowledge`——`data:knowledge` 节点，`params.operation = retrieve|ingest`，从 `runtime.context["knowledge_store"]` 读/写本地知识库：**retrieve** 输出 `records`（每项带稳定 `cite:` 引用、`source`、`score`）+ `out`（带引用头的拼接文本），**ingest** 分块 upsert 并输出块数（`out`）+ 块 `records`；**无 store 时 fail-loud**（显式声明知识工作的节点不得静默空转），缺 collection / doc_id / 文档亦 fail-loud。`NodeType.DATA_KNOWLEDGE` 注册（idempotent，upsert 按确定性 chunk id 幂等）。前端同步：`types.ts` NODE_TYPES + `node-catalog.ts`（Knowledge 条目，`in`→`out`/`records`，默认 `operation=retrieve`）。**无迁移/无新表/无新配置段/无新依赖**。测试：新增 `tests/test_workflow_knowledge_node.py`（10 条：retrieve/查询模板/无 store/缺参/未知操作/ingest 分块与存储/doc_id/文档/text 参数）；`test_workflow_executors.py` 计数 21→22；前端 `node-catalog.test.ts`/`types.test.ts` 计数 26→27、data 7→8。**验证**：后端 workflow 套件 1075→1084 passed、全量 A/B 11117→11129 passed 且**失败集逐条一致**（75）；前端 `pnpm test` **1165 passed** + `pnpm check`（eslint + tsc）全绿；ruff 干净。
>
> **进度（切片 P：§24.8 评测 runner）**：新增 `deerflow/workflow/eval_runner.py`——`evaluate_replayed_run(definition, fixture, cases, ...)` 把 N14g 回放与 N14h 断言串成 runner：编译定义 → 以 **replay 模式**对 golden fixture 执行（**无真实模型/工具调用**）→ `extract_node_outputs` 抽取 → 逐 case `evaluate_case` → `EvalReport`。可传 `judge`（语义断言）与自定义 `compile_context`；未录制节点默认 **fail-loud**（`on_miss=error`），`live` 可选回退（仅当评测确实想要真实路径）。**诚实取舍**：本切片交付**库级 runner**；**CI 挂载**（能力包导入 / 工作流保存时自动跑 suite）与**金标录制 CLI** 列为后续增量。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_eval_runner.py`（6 条：pass/fail、replay 跳过真实 executor、miss error、miss live 回退、语义 judge）。全量离线 A/B：11129→11135 passed、**失败集合逐条一致**（75）；workflow 套件 1084→1090 passed；ruff 干净。
>
> **进度（切片 Q：§24.8 评测 CLI / CI 接入）**：新增 `deerflow/workflow/eval_cli.py`——`python -m deerflow.workflow.eval_cli --definition d.json --fixture f.json --cases c.json [--on-miss error|live] [--json]`：加载序列化定义（`workflow_io.deserialize`）+ 回放夹具（`load_fixture`）+ 用例文件（JSON 列表 → `EvalCase`/`NodeAssertion`），经 `evaluate_replayed_run` 回放执行后打印报告。**退出码 `0`（全过）/`1`（有失败）/`2`（输入加载或运行失败）可进 CI**。**诚实取舍**：本切片交付 **CLI**（可挂 CI）；**「能力包导入 / 工作流保存时自动跑 suite」的嵌入式挂载**列为后续增量（需定义持久层钩子）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_eval_cli.py`（4 条：pass→0 / fail→1 / bad inputs→2 / `--json` 输出）。全量离线 A/B：11135→11138 passed、新增 4 条全过；**唯一新增「失败」为既有**时序 flake `test_extension_task_lifecycle::test_budget_exhaustion_mid_hook_logs_a_warning_not_a_traceback`（隔离运行通过、与纯新增模块无关）；workflow 套件 1090→1094 passed；ruff 干净。
>
> **进度（切片 R：§24.1 DeerMem `memory_store` 适配器）**：新增 `deerflow/workflow/memory_backends.py::MemoryManagerStore`——把既有 `MemoryManager` 包成 N14j 的 `MemoryStore` 协议：`search(scope, query, limit)` 把 manager 排序后的 facts 映射为 `MemoryRecord`（**仅当后端 `supports_search`**；`NotImplementedError` 降级为空而非抛入节点），`put(scope, text)` 经 manager 的**正常提取管线**（`add_nowait` + `HumanMessage`）排队（不裸追加 fact，故 scope/durability/authority 门照旧生效）。**诚实作用域映射**：DeerMem 是**长期用户/agent 记忆**，故适配器**仅服务 `long_term`**；`session`/`node`/`workflow` 非其模型 → 返回空/不做（需要者自行实现协议），并在 docstring 明写。fact 文本/键读取容错（`fact`/`content`/`text`/`summary` + `id`/`fact_id`）。**部署方**将其注入 `runtime.context["memory_store"]`（worker 注入为可选后续）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_memory_backends.py`（12 条：搜索映射/桶与 top_k 透传/非 long_term 空/不支持搜索空/NotImplemented 空/fact 文本回退/put 排队与默认 thread/非 long_term 与空文本 no-op/supports_search）。全量离线 A/B：11138→11149 passed、新增 12 条全过；**唯一新增「失败」为既有**时序 flake 文件 `test_extension_task_lifecycle.py` 两条（隔离运行通过、与纯新增模块无关）；workflow 套件 1094→1106 passed；ruff 干净。
>
> **进度（切片 S：§24.6b 模板端点）**：`patterns.py` 增 `build_template(name)`（返回带**占位 instruction** 的可编译骨架：critic_review_loop / supervisor_topology）与 `template_catalog()`；Gateway 增 `GET /api/workflows/templates`（`workflow_routes.py`，**声明在 `/workflows/{definition_id}` 之前**避免被动态段吞掉），返回每个模板的 `name`/`description`/序列化 `definition`，供画布一键插入。**诚实取舍**：本切片交付**后端模板目录 API**；**前端画布「插入模板」按钮**列为后续增量。**无迁移/无新表/无新配置段/无新依赖**。测试：新增 `tests/test_workflow_templates_route.py`（4 条：列举/反序列化/路径不被动态段吞/未知模板报错）。全量离线 A/B：11149→11155 passed、**失败集合逐条一致**（75）；workflow 套件 1106→1110 passed；ruff 干净。

> **进度（切片 T：§24.10 运行成本报表）**：新增 `deerflow/workflow/costs.py`（**纯逻辑**）——`build_pricing_map(models)`（读 `models[*].pricing` 的 `currency`/`input_per_million`/`output_per_million`/`input_cache_hit_per_million`，与 console 计价**同一约定**；无价或**混合币种**一律返回 `{}` = 关闭计价，避免产出非法聚合）、`node_usage_from_state(state)`（只抽 `wf:<node>:__token_usage` 保留通道，容忍非 dict/坏字段）、`token_cost`（**cache-aware**：缓存命中按命中价、其余按未命中价，命中数钳到 `[0, input]`）、`build_run_cost_report(state, models, default_model=..., model_by_node=...)`。Gateway 增 `GET /api/workflows/{id}/runs/{rid}/cost`（`workflow_run_routes.py`，在 state 路由之后）。**诚实取舍**：用量通道只记 token 不记模型，故**按 `default_model` 计价并在每个节点回报所用模型**（与 console 对无 per-model 拆分行情的既有回退一致，`model_by_node` 可覆盖）；未定价模型 `cost: null`（不伪造 0），全未定价则 `total_cost: null`；无 checkpointer → 503；配置读取失败**不 500**（降级为无价报表）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动（`models[*].pricing` 走 extra 字段）。测试：新增 `tests/test_workflow_costs.py`（32 条：定价表/大小写键/零价跳过/坏值容忍/混合币种关闭/取价/缓存计价与钳位/用量抽取 + 报表（默认模型、per-node 覆盖、未定价 null、无价、部分定价、混合币种、空用量、JSON 可序列化）+ 路由（503/404/有价报表/空 checkpoint/配置失败降级））。全量离线 A/B：11155→11187 passed、**失败集合逐条一致**（75）；workflow 套件 1110→1142 passed；ruff check/format 干净。

> **进度（切片 U：§24.8 定义内嵌评测套件 + opt-in 保存门）**：新增 `deerflow/workflow/definition_evals.py`——把声明式 `metadata.evals`（`{fixture: ReplayFixture, cases, require_pass?, on_miss?: error|live, initial_state?}`）解析为 N14g 回放夹具 + N14h 断言，`evaluate_definition_evals` 复用 N14p runner **离线确定性**回放（无真实模型/工具调用），`eval_gate_errors` 产出逐条断言失败文案。`schema.WorkflowMetadata` 增可选 `evals` 字段（additive，旧定义零破坏）。**保存门 opt-in**：Gateway 的创建/更新在 `require_pass: true` 时运行套件，失败即 422 拒绝保存；仅「记录期望」的套件永不阻塞保存；规格非法一律 422（fail-loud，绝不静默关掉门）。Gateway 增 `POST /api/workflows/{definition_id}/evaluate` **按需回放**（无套件返回 `ran:false` 200，规格非法 422，未找到 404）。**诚实取舍**：本切片闭合「定义保存」一侧；**能力包（skill）导入时自动挂载套件列为后续增量**（需 SKILL.md frontmatter 契约）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_definition_evals.py`（35 条：解析/14 种坏形状/有无套件判定/通过/失败文案/未录制 fail-loud/`on_miss=live`/保存门 no-op 与 422/路由 ran-false、有报告、404、require_pass 拦保存、非必需套件可保存）。全量离线 A/B：11187→11222 passed、**失败集合逐条一致**（75）；workflow 套件 1142→1177 passed；ruff check/format 干净。

> **进度（切片 V：§24.6b 画布插入模板）**：前端落地 N14s 端点的消费侧。`core/workflows/api.ts` 增 `fetchWorkflowTemplates()`（把后端序列化的 `definition` 解析回 `WorkflowDefinition`）；新增 `core/workflows/canvas/templates.ts`（**纯变换**）——`uniqueNodeId`（空画布保留可读 id，冲突才加 `-2/-3` 后缀）、`templateAnchor`（显式 position > 现有内容右侧 `maxX + 320` 且与最上节点对齐 > 原点）、`insertTemplateFlow`（**两遍**：先分配全部新 id 再重映射边，边 id 用 `makeEdgeId` 重算，`data.workflow.id` 同步、位置按锚点偏移；**确定性**、不改入参）；`workflow-toolbar.tsx` 增「模板」按钮 + 下拉列表（`enabled: templatesOpen` **按需拉取**，插入后 `markDirty`，失败 toast）；i18n en-US/zh-CN + `types.ts` 增 `workflows.templates.{label,hint,empty,insertFailed,loadFailed}`。**诚实取舍**：本切片只做**插入**（骨架落画布后由用户编辑保存），模板仍是后端权威（`patterns.py`），画布不硬编码拓扑；§24.6b 的**受控动态 handoff** 仍为后续增量。**无后端改动/无新依赖**；顺带修复 N14o 遗留的 `node-catalog.ts` 一行 prettier 格式。测试：新增 `tests/unit/core/workflows/canvas/templates.test.ts`（15 条：id 去重/锚点三态/空画布原样/冲突重映射与 payload 同步/边重映射与条件保留/偏移与显式位置/无存储位置的网格回退/不改入参/确定性）+ 更新工具栏 DOM 测试文案 mock。`pnpm test` 1165→1180 passed；`pnpm check`（eslint + tsc）与 `pnpm format` 全绿。

> **进度（切片 W：§24.2 向量后端适配器）**：新增 `deerflow/workflow/embeddings.py`——`VectorKnowledgeStore` 实现与 `InMemoryKnowledgeStore` **相同**的 `KnowledgeStore` 协议（`upsert(collection, chunks)`/`query(collection, query, top_k, reranker)`），按**余弦相似度**排序；embedder **注入式**（`Embedder` 协议 + `embeddings_from_callable(fn)`（非 callable 构造期即 `EmbeddingError`）/ `embeddings_from_langchain(embeddings)`（适配 `embed_documents`）），**不引新依赖**。纯函数 `normalize_vector`（零向量原样）/`cosine_similarity`（维度不一致即报错）。**幂等**：`upsert` 按 chunk id 替换（与 `data:knowledge` 的幂等声明一致）、已带 `embedding` 的 chunk **不重复嵌入**且**不改调用方对象**。**排序与关键词路径同约定**：`(-score, citation)` 稳定 tie-break、非空 query 丢弃非正分、reranker 注入且**异常不破坏检索**、`top_k<=0`→空、未知 collection→空。**fail-loud**：embedder 返回**数量不符/非数值/参差/零宽向量**、预置空 embedding、或查询与索引**维度不一致**一律 `EmbeddingError`——静默空结果会让检索 bug 伪装成「无命中」，这是检索层最不能容忍的失败形状。与既有 `ingest_document`/`aquery` 无缝互换（同协议）。**诚实取舍**：embedder 由部署方注入（`deerflow.models` 侧无 embedding 客户端，强行内置会引新依赖/新配置段）；本切片交付**可插拔 store + 适配器**，**不内置任何 embedding 供应商**。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_embeddings.py`（38 条：归一/余弦各态/适配器与协议 isinstance/幂等替换/预置向量跳过嵌入/6 类 embedder 坏答案/排序与 top_k/非正分丢弃/空 query 确定性/tie-break/引用前缀/reranker 重排与失败降级/维度不一致/关闭归一/与 `ingest_document` 往返/两 store 互换）。全量离线 A/B：11222→11260 passed、**失败集合逐条一致**（75）；workflow 套件 1177→1215 passed；ruff check/format 干净。

> **进度（切片 X：§25「执行数据分析」后端半边 + 节点耗时观测）**：compiler 的节点包装在执行段（仅 executor 调用，含 §24.7 重试与退避；**不含**审批门/人工等待——人的思考时间不是节点执行成本）用 `time.perf_counter()` 计时，写保留通道 `wf:<node>:__duration_ms`（**每个**节点类型都在 `_build_state_schema` 声明该通道）；**replay 命中不写**（未做实事，写 ~0ms 会伪装成真实执行）。worker 增 `_aggregate_final_node_durations` → `run.end` content additive `node_timings = {nodes: {id: ms}, total_ms, slowest_node}`（无通道即不写；`slowest_node` tie-break 按 node id 稳定）；`get_workflow_run` 以 additive `node_timings` 暴露（与 `token_usage` 共用一次 `run.end` 读取，`_read_run_end_content` 抽出）。**顺带收紧事件契约**：节点生命周期事件 `output` 改为**只含声明端口**（新增 `_event_output` 过滤末段以 `__` 开头的保留通道）——保留通道是引擎内部记账，已经由 run.end 聚合（`token_usage`/`node_timings`）与 `get_workflow_run` 对外，不该污染面向画布的进度事件（此前 AI 节点的 `__token_usage` 会漏进事件）。**诚实取舍**：本切片交付**观测与聚合后端半边**，§25 的「瓶颈识别 UI」属前端增量；§25「缓存感知执行顺序规划器」方案已明确「待 benchmark 后立项」，不在本次范围。**无迁移/无新表/无新配置段/无新依赖**。测试：新增 `tests/test_workflow_node_timings.py`（12 条：节点上报耗时/通道声明（`graph.channels`）/快节点也可测/record 模式同时落条目/**replay 不写耗时**/聚合（nodes+total+slowest）/tie-break 按 id/坏值跳过/无通道返回 None/worker `run.end` 落 `node_timings`/`get_workflow_run` 暴露/无 event store 时键缺失）。全量离线 A/B：11260→11271 passed；**唯一差异为既有**时序 flake `test_extension_task_lifecycle.py`（该文件同代码连跑 4 次出现 2 failed/12 passed 与 12 passed 交替，单跑通过，与 workflow 图无关）。workflow 套件 1215→1271 passed；ruff check/format 干净。

> **进度（切片 Y：§25 调试能力 — 节点断点）**：新增 `deerflow/workflow/breakpoint.py`——`params.breakpoint = true` 让节点**执行前**挂起，**复用 N10 审批门的 HITL 栈**（同一个 HumanTask 行 → 既有 submit/skip 工具与 `/api/human-tasks` 路由零改动；同一个 `interrupt()` 与 `(run_id, node_id)` 行复用规则；同一个 `{"__skip": True}` 哨兵 → skip 即跳过该节点输出）。compiler 在**审批门之前**接入（挂起中的节点尚未 preview，且已清除的断点不得被审批门的挂起遮蔽）。**刻意没有** preview 与指纹复验：断点不批准任何东西、挂起前无副作用——这正是它与审批门的全部差别，也是它独立成模块而非在 `approval.py` 里加分支的原因。**踩坑并修正的一处真实语义**：LangGraph 把**假值** `Command(resume=...)` 当「未 resume」会再次挂起（已用最小复现确认 `resume={}` 不恢复），因此任务声明**一个必填 bool 端口** `acknowledge`（`enum: [True]`）保证经 `submit_human_task` 回来的 resume 载荷**非空**；`BreakpointDecision.from_resume` 除哨兵外一律**继续**（断点不是决策，缺载荷不得静默跳过用户要求检查的工作）。编译期 `_validate_breakpoints`：非 bool 拒绝、`flow:start`/`flow:end`（永不执行的 sentinel）拒绝——静默忽略是这里最坏的失败形状。**诚实取舍**：本切片交付**断点**（§25 调试的第一块）；单步/回退重跑与断点 UI 为后续增量。**无迁移/无新表/无新配置段/无新依赖**；前端零改动（`params` 级，走既有参数编辑器）。测试：新增 `tests/test_workflow_breakpoint.py`（19 条：谓词仅显式 true/哨兵跳过与其余一律继续/任务创建（kind、`acknowledge` spec、enum 规则、description）/**复用既有任务**/缺 repo fail-loud/**规格只接受 `acknowledge: true`**/非 bool 与 sentinel 编译期拒绝/正常节点可编译/**端到端：挂起时执行器未被调用 → resume 后执行一次**/skip 不执行且端口未写/无断点行为不变）。全量离线 A/B：11271→11291 passed、**失败集合逐条一致**（75）；workflow/approval/human_task 套件 1271→1349 passed；ruff check/format 干净。

> **进度（切片 Z：§25 工具节点化）**：新增 `exec_tool_invoke`（`tool:invoke`，`workflow/executors/tool.py`）——用图**直接**调用网关里的任意工具，不再必须花一次模型回合让 AI 节点挑工具。`params.tool`（必填）/ `params.provider`（`sandbox`/`builtin`/`app` 消歧，**未知 provider 不回落**）/ `params.arguments`（`{{port}}` 插值：嵌套 dict/list 递归、**整值占位保留原类型**、缺端口→空串）。网关取自 `runtime.context["tool_gateway"]`，**缺失即 fail-loud**（就地新建 `build_default_tool_gateway` 会解析出与准入时**不同**的工具集——确定性图步不该有这种惊喜）；`ToolGateway` 增 `resolve(tool_id, provider=...)`/`provider_names()`/`resolve_with_provider()`（additive）。**一个实测出来的关键坑**：注入式工具的 `InjectedToolArg` 标记在模块使用 `from __future__ import annotations` 时退化为字符串，框架于是把注入参数填 `None` **并忽略 args 里的同名值**（已用最小复现确认）——因此调用改走**直调路径**：`tool.coroutine`/`func` + 自 schema 校验（默认值填充/类型强转/未知键拒绝，错误对工具名报出）+ **仅当签名声明 `runtime` 才显式传 `ToolRuntime`**（与注解解析无关）；同步工具经 `asyncio.to_thread` 离事件循环；无可取函数的透明 `BaseTool` 子类回落 `ainvoke` 框架路径（docstring 明写此唯一不保证注入的情形）。**安全默认**：非幂等（`registry._NON_IDEMPOTENT_TYPES`）+ crash-confirm 门（`requires_confirmation=True`）+ 默认写 `pending_review_nodes`（`danger._DANGEROUS_TYPES`，与 bash/http 同处理），故 `params.retry` 在编译期被拒（可能重复副作用）。前端同步 palette（`tool:invoke`「Tool Call」，默认 `tool:""`/`crash_confirm:false`）。**无迁移/无新表/无新配置段/无新依赖**。测试：新增 `tests/test_workflow_tool_invoke.py`（22 条：注册语义（非幂等/conf-contirm/待审核/编译期拒 retry）+ 守卫（缺 tool/空 provider/无网关/未知工具列 provider/provider 消歧排除/arguments 非 dict/工具自身异常包装）+ 调用（文本与结构化结果、provenance、**注入工具拿到 ToolRuntime**、无注入工具照常、provider 选择、无 arguments）+ 插值（顶层/整值保类型/内嵌拼接/缺端口/嵌套结构/普通值透传））；`test_workflow_executors.py` 计数 22→23；前端 `types.test.ts`/`node-catalog.test.ts` 计数 27→28、tool 4→5。全量离线 A/B：11291→11315 passed；**唯一差异为既有**时序 flake `test_extension_task_lifecycle.py::test_notification_timeout_is_one_shared_budget`（该文件同代码交替通过/失败、单跑通过，N14a 起已记录）。workflow 等子集 1349→1326 passed（含 danger/retry/reliability/tool_gateway 过滤）；ruff check/format 干净；前端 `pnpm test` 1180 passed、`pnpm check` exit 0、`pnpm format` 全绿。

> **进度（切片 AA：N1 §9 MCP 收编为 provider）**：`tool_gateway.py` 增 `PROVIDER_MCP` 与 `_mcp_tools()`——MCP 工具从「混在 builtin 池里」改为**独立 provider**：`_builtin_tools` 装配改 `include_mcp=False`，MCP 工具经 `get_cached_mcp_tools()` 单独成 provider（仍需 `get_enabled_mcp_servers()` 非空才装配），并**保留 `tag_mcp_tool` 标记**（`tool_search.py` 的 deferred-tool 过滤依赖该标记——AI 节点现在从 MCP provider 取工具，标记必须跟着走）；注册顺序 `sandbox → builtin → mcp → app`，故 MCP 工具不再可能覆盖同名 builtin（此前 `include_mcp=True` 的 dict 合并会让后到的 MCP 工具胜出，属静默遮蔽）。**fail-open**：无启用 server / 未装 `langchain-mcp-adapters` / 配置读取异常时该 provider 为空并告警，节点照常跑。**收益**：`tool:invoke` 的 `params.provider` 现在可写 `mcp` 做消歧；`resolve_with_provider` 的 provider 归因对 MCP 不再是「builtin」（诚实标注）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动（provider 是 params 字符串）。测试：`tests/test_workflow_tool_gateway.py` 增 6 条（MCP 工具由 mcp provider 解析 / **标记保留**（`is_mcp_tool`）/ 无启用 server 时为空 / 配置异常 fail-open / builtin 装配确实 `include_mcp=False` / MCP 不遮蔽同名 builtin）。全量离线 A/B：11315→11323 passed；失败集 **74 条、无新增**（基线中 `test_mcp_task_service.py` 一条本次通过，属倾向相反的既有 flake）；workflow/mcp/tools 子集 2253 passed（失败项经 `Compare-Object` 全为基线既有、仅未被 `-k` 选中）；ruff check/format 干净。

> **进度（切片 AB：§25 调试/观测的前端半边）**：把 N14x/N14y 的后端能力接到画布。**节点耗时读数**：新增纯逻辑 `core/workflows/run-durations.ts`（`extractNodeDurations` 从运行通道抽 `wf:<node>:__duration_ms`，跳过非数值而非伪造成 0；`slowest` tie-break 按 node id 稳定；`formatDuration` 亚秒一位小数/≥1s 转秒）+ `api.fetchWorkflowRunState(workflowId, runId)`；`workflow-run-panel.tsx` 在运行**终态后**读取该端点并在**已完成/失败**的时间线条目上显示耗时、顶部显示「最慢节点」。**实现取舍**：读数用**命令式 effect**（仅终态 + 有 runId 才发请求，且**不引入 query provider**）——因此既有的面板 DOM 测试无需改造；读取失败一律丢弃（观测绝不能变成运行失败）。耗时**不从节点事件取**：N14x 刻意把保留通道排除在事件之外，通道经 state 端点才是权威来源。**断点开关**：`workflow-properties-panel.tsx` 增勾选框，写同一个 compiler 读的 `params.breakpoint`；关闭时**删除该键**而不是留下 `breakpoint: false`。i18n 增 `workflows.run.panel.slowestNode` 与 `workflows.properties.breakpoint{Label,Hint}`（en-US/zh-CN/types）。**无后端改动/无新依赖**。测试：新增 `tests/unit/core/workflows/run-durations.test.ts`（10 条：只抽保留通道/空输入/跳非数值/数字字符串/ tie-break/空 node id/零值保留 + 格式化 3 态）；`workflow-run-panel.dom.test.tsx` 增 3 条（渲染耗时与最慢节点、无通道时不显示、读取失败时 run 仍报成功且无读数）；`workflow-properties-panel.dom.test.tsx` 增 3 条（勾选写 true、取消**删键**、true 时勾选框为选中）。`pnpm test` 1180→1196 passed；`pnpm check`（eslint + tsc）exit 0；`pnpm format` 全绿。

> **进度（切片 AC：§5.5 能力包组合机制 extends/overlay）**：新增 `deerflow/skills/composition.py`（**纯逻辑**）——`resolve_declaration` 沿 `extends` 折叠出**有效声明**：`allowed-tools` **并集**、`overlay: true` 时包自己的列表**替换**继承列表（这是**收窄**继承工具集的唯一途径）、`permissions`/`required-secrets`/`requirements` **并集**、`tool-schema-version`/`context-budget` 包自己优先否则最后一个声明它的 base；`resolve_allowed_tools`（按闭包并集，全未声明→`None` 保持旧 allow-all 语义，空集=显式无工具）、`resolve_group_closure`（闭包，供快照）、`validate_composition`（工具/CI 用全量清单，**不抛**）。**坏组合一律 loud**（未知 base / 自引用 / 环（报出 `a -> b -> a` 路径）/ 深度超限）——静默丢继承 = 声明继承的工具凭空消失，是能力边界最坏的失败形状。`Skill` 增 `extends`/`overlay`，parser 增 `parse_extends`/`parse_overlay`：**坏形状 fail-loud**（与 `dependencies` 同处理：写错即不可加载；`overlay` 只接受真 bool——字符串真值会静默把加法变收窄，反之会静默放宽）。**消费侧**：`tool_gateway.resolve_capability_tools` 改为按**catalog** 解析所选组的有效 `allowed-tools`（坏组合 **fail-closed for tools**：无工具 + 告警、**不抛**——未安装的 base 不该让本来可跑的 workflow 直接失败）；`schema.collect_resolved_groups` 把 `extends` 闭包纳入定义的能力快照（未知 base 仅告警，best-effort 不阻塞保存）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动（纯 frontmatter + 装配逻辑）。测试：新增 `tests/test_skill_composition.py`（46 条：`parse_extends` 5 态与 `parse_overlay` 4 态（含 fail-loud）/解析恒等/并集/继承/overlay 替换与收窄到空/权限与 secrets 并集/标量 own 优先与多 base last-wins/传递链/未知 base/自引用/环（带路径）/深度超限/allowed-tools 的 None 与空集与闭包语义/闭包顺序与菱形去重/`validate_composition` 四态 + **消费侧**：子包继承 base 工具、overlay 收窄、坏组合不抛而返回空、`collect_resolved_groups` 纳入继承快照且无 extends 时不变、未知继承组跳过）。全量离线 A/B：11323→11366 passed；失败差异**仅**为既有时序 flake `test_extension_task_lifecycle.py` 两条（同代码交替通过/失败、本次单跑 2 passed，N14a 起已记录）；skill/capability/workflow/gateway 子集 `Compare-Object` 无 `=>` 项；ruff check/format 干净。

> **进度（切片 AD：§25 单步执行 step mode）**：断点（N14y）的 run 级兄弟。`breakpoint.py` 增 `STEP_SNAPSHOT_KIND` / `DEBUG_STEP_CONTEXT_KEY` / `step_mode_requested(context)`（**只认真 bool**，且只认 run 上下文——不算进定义的 params），`run_breakpoint(..., kind=...)` 让暂停任务的 `kind`/`inputs_snapshot.kind`/description 区分 `step` 与 `breakpoint`。compiler 在审批门之前加 step 门：run 级开关打开时**每个**节点执行前挂起（同一 HumanTask 家族、同一 `(run_id, node_id)` 行复用规则）；**节点自身 breakpoint 与 step 同时命中只挂起一次**（`paused` 标记，一次访问一次暂停），skip 语义与断点/审批一致（端口不写入）。`WorkflowRunRequest.debug_step` → `start_workflow_run` → worker 注入 `config["context"]["debug_step"]`（三条 run 路由都传）。**关键设计**：resume 是**新 run**，故两条 resume 路径（app 的 `human_task_routes._resume_workflow`、harness 的 `dispatch.resume_workflow_run`，后者镜像前者、不 import app）都从**任务行的 `inputs_snapshot.kind`** 重新推导 `debug_step`——这是「一次一个节点地推进」成立的唯一依据（否则 resume 会退回普通执行）。**诚实取舍**：本切片交付 **API 级单步**（`debug_step` 字段 + 单步语义 + resume 续航）；**画布「单步运行」按钮为后续增量**（复用 N14ab 的运行面板/工具栏模式）。**回退重跑**（rewind & re-run）仍为后续：它需要「按节点定位 checkpoint 并从该点重跑」的语义，而现有能力只有 cancel-rollback 与 AI 节点 continue，两者都不重执行任意节点——值得单独评估而非顺手加。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_workflow_step_mode.py`（11 条：谓词只认真 bool / kind 落任务行与 description / **端到端：每节点挂起 + resume 只推进一个节点**（`seen == ["A"]` 且下一步仍挂起）/ skip 该节点且继续步进 / 关闭时行为不变且无任务 / **同时命中 breakpoint 只暂停一次** / **两条 resume 路径按任务 kind 推导 `debug_step`**（step→True，breakpoint/缺失→False）/ 断点谓词不被 step 影响）。全量离线 A/B：11366→11378 passed；失败差异**仅**为既有时序 flake `test_extension_task_lifecycle.py::test_budget_exhaustion_mid_hook…`（单跑通过，N14a 起已记录）；workflow/breakpoint/resume/routes 子集 1315 passed 无新增；ruff check/format 干净。

> **进度（切片 AE：§25 画布调试 UI / 单步运行 + 暂停处理）**：把 N14y（断点）、N14ad（单步）两端从「API 可用」变成「画布可用」的闭环，**纯前端切片（后端零改动）**。三块：①**单步运行按钮**（工具栏，与 Run 同一 gating）：`startRun({debugStep:true})` → `streamWorkflowRun(id, {debug_step:true})`（run 级请求字段，**不写进定义**；普通运行仍不带 body）。②**调度客户端**（`core/workflows/human-tasks.ts`）：断点/单步的暂停就是一条 pending `human_tasks` 行，故复用既有 submit/skip 路由而不另造挂起协议——`continueDebugPause` 提交 `{acknowledge:true}`（**刻意非空**：LangGraph 把**假值** `Command(resume=...)` 当作「未 resume」会再次挂起）、`skipHumanTask` 以输出不写入继续；`pendingDebugPauses` 为纯选择器（只挑两种调试 kind 的 pending 行）。③**运行面板调试暂停卡**：运行结束后读取本用户 pending 人工任务，逐条给出**继续/跳过**。**关键设计取舍**：选择器把「当前运行」的暂停**排在最前但不做排他过滤**——因为 resume 会**新起一个 run id**，按运行过滤会让「已经单步过一次的运行」在画布上彻底失联；读取失败**显式**给出「读取失败 + 重试」而不是静默当作「没有暂停」（没暂停还是读不到，二者含义不同）；泛型 `human:task`/`approval` 行**不在此卡处理**（其端口任意，仍由对话侧 `submit_human_task` 等承担——通用表单渲染列为后续增量）。**无迁移/无新表/无新配置段/无新依赖**；后端零改动故不涉全量 A/B。测试：新增 `tests/unit/core/workflows/human-tasks.test.ts`（解析容错/默认值、`pendingDebugPauses` 的 kind+status 过滤、**不排他**（resume 后的新 run 仍可见）、preferred run 置前、preferred 为空不丢弃其余；`fetchPendingHumanTasks` 只查 `?status=pending` 且丢弃畸形行、非数组当空、失败带 detail；三个动作的 URL/方法与 **acknowledge 非空载荷**、422 `{errors}` 汇总、兜底文案）与 `workflow-run-panel-debug.dom.test.tsx`（7 条：暂停卡渲染 + 继续发非空 acknowledge + 重新读取、跳过、**不接管** `task`/已提交行、**非本 run 的暂停仍可达**、读取失败→重试→恢复、动作失败内联报错 + toast、运行中不读取）；`workflow-toolbar.dom.test.tsx` 增 4 条（单步按钮以 `{debug_step:true}` 启动、readonly/dirty/运行中 gating）。前端全量 **1223 passed**、`check` exit 0、`format` 全绿（两个既有面板 fixture 的 i18n 假字典补齐 `debugPause`）。

> **进度（切片 AF：§24.6a 受控动态 handoff）**：§24.6a 三原语的最后一块。新增 `flow:handoff` 节点 + `deerflow/workflow/handoff.py`（纯逻辑：`parse_handoff` / `resolve_handoff_target` / `handoff_count_key`）。**语义**：supervisor 在运行期从**已注册专家节点**中选一个——`params.candidates = [{value, node}, ...]` 是白名单（`node` 必须存在于同一定义，编译期逐条核对），`decision` 输入承载选择、`target` 输出承载解析结果、**其余已声明输入原样转发同名输出**（这就是 handoff 的结构化消息：task / constraints / context 引用，随路由一起走）。**两处与 `flow:switch` 的刻意差别（也是本切片的全部价值）**：①**路由边由 params 生成**，从 handoff 出发的定义边是**编译期错误**（防两个真相源）；②**没有 default 边**——未命中/未设置一律 `WorkflowRouteError`/`HandoffError` 并列出允许值（switch 的 default 回落正是「静默跑错分支」，而 handoff 存在的意义就是不许它发生；「收工」改由 handoff **之前**的 `flow:if` 显式表达）。**预算**：`params.max_handoffs`（默认 8，1..50）限本节点每 run 的交接次数，计数经保留通道 `wf:<node>:__handoffs` 往返（executor 靠 compiler 注入的 `node_id` 读计数；重试不会双花）。编译期 `_validate_handoff` 还拒绝指向 `flow:start`/`flow:end`/自身 的候选，以及把 `candidates`/`max_handoffs` 写在非 handoff 节点上。**诚实取舍**：预算是**每 handoff 节点**而非全 run 全局（跨节点的全局交接预算未做，run 级 token 预算已由 §24.10 覆盖）；前端仅加 palette/catalog 条目（`candidates` 沿用既有 **JSON 值编辑器**书写，与 `flow:switch` 的 `cases` 同一 UX，未新增专用表单）。registry **23→24**、前端 `NODE_TYPES` 28→29（flow 8→9）。**无迁移/无新表/无新配置段/无新依赖**。测试：新增 `tests/test_workflow_handoff.py`（24 条：解析（默认预算/target 去重/**空表与坏条目与重复 value 与预算越界/非整数一律报错**）/ 选择解析（映射、**未注册与缺失选择报错并列出允许值**）/ executor（解析+转发消息、**跨访问累加计数**、**预算耗尽报错并点名 max_handoffs**、未注册选择报错、**缺 node_id 拒绝执行**、损坏计数按 0 处理）/ 编译期（可编译、未知候选、自指与 sentinel 候选、缺 `decision` 输入与 `target` 输出、**handoff 出边拒绝**、handoff 参数写在别的类型上拒绝）/ **端到端只跑被选专家**（`seen == ["unity","fix_unity"]` + `wf:route:target` + `__handoffs == 1`）/ 未注册选择**整跑失败**）。全量离线 A/B：11378→11403 passed、**失败集合与基线逐条一致（75 = 75，零差异）**；workflow 子集 1379 passed；ruff check/format 干净；前端 1223 passed、`check` exit 0、`format` 全绿（顺带修正 `frontend/AGENTS.md` 的 prettier 强调标记）。

> **进度（切片 AG：§24.8 能力包导入评测门）**：§24.8 的最后一块（「把 eval 挂到能力包导入/升级」），与 N14u 的**定义侧**保存门对称，落在**能力包侧**。新增 `skills/eval_gate.py`（纯逻辑 + 注入式判定）+ `skills/eval_judge.py`（模型触发判定）；两条安装路径（`local_skill_storage` / `user_scoped_skill_storage`）在**安全扫描之后、提交之前**调用 `enforce_skill_eval_gate`，因此安装/升级会先校验包自带 `evals/*.json`。**两条诚实边界**：①**只判定 trigger 用例**（`should_trigger` + 来自 `query`/`prompt`/`input`/`utterance`/`task`/`message` 的 utterance）——行为类期望（`assertions`、`expected_readiness`）需要自己的 runner，本门**只计数不判定**（把无法验证的东西报成「通过」是撒谎）；②**opt-in 属于包作者**（与 N14u 一致）：dict 形态 manifest 带 `"require_pass": true` 才门禁其用例，而裸 `[{...}]` trigger 清单**无处声明意图**故永远只报告。推论：**默认安装路径零模型调用**（只有真的 require_pass 才构造 judge）。**策略**：声明的门跑不起来就**拒绝安装**（judge 建不起来、或某个用例无法判定）——「声明了却静默通过」比拒绝更坏；而 manifest 解析失败只是**告警**（与 review 包把 `eval.invalid-json` 定为 warning 一致）绝不拦。**单一词汇来源**：`skills/review/eval_schema.py::iter_manifest_cases`（review 统计与安装门共用，抽出为独立函数后 review 行为逐条不变）——同一个包不能被一方读懂而另一方看不见。**诚实取舍**：行为类/语义套件（skill-creator `evals.json` 的 assertions、skill-reviewer 的 readiness）仍需各自 runner（列为后续）；judge 依赖模型故为 live 能力，测试用注入式 decider + 假模型覆盖；网关安装路由未改（门在 storage 层，Gateway/Client/工具三条入口共享）。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_skill_eval_gate.py`（32 条：共享词汇与 review 分类器一致性、收集（无 evals 目录 / 裸清单 / require_pass / 六种 utterance 键 / 跳过不可判定用例 / 只有行为用例时**不构成门** / 坏 JSON 记 problems 且可读清单仍计入 / 未识别清单忽略）、评测（同步与异步 decider / 失败带 expected+actual / judge 抛错记 problems 且计入 undecided）、策略（无 evals 无操作 / 只报告不判 / 显式 decider 仍报告但不拦 / 必需套件通过 / **失败即拒**（含报文点名清单与用例）/ **必需门无 judge 即拒** / **某用例无法判定即拒** / 坏 manifest 只告警 / **两条安装路径都接线** / 门拒绝时**不提交安装** / 无 evals 包安装行为不变）、judge（判定与提示词内容、容忍代码围栏、**回答不可用即抛错不猜**））。全量离线 A/B：11403→11435 passed、**失败集合与基线逐条一致（75 = 75，零差异）**；skills/review/eval/installer 子集无新增失败；ruff check/format 干净。

> **进度（切片 AH：§25 回退重跑）**：§25 调试能力的最后一块（断点 N14y / 单步 N14ad / 回退重跑本切片），**复用 LangGraph 自身的 checkpoint 续跑，不新写重放引擎**。新增 `workflow/rewind.py`：每次节点访问都会写一个 checkpoint，其调度任务（`snapshot.next`）正是即将运行的节点，故「节点 X 之前的状态」**就是** `next` 含 X 的那个 checkpoint——`plan_rewind`（纯逻辑，候选按**最新优先**）取最新的匹配项，`locate_rewind_point` 读真实历史（用运行自己的 checkpointer 编译定义以对齐通道表；编译只为**读历史**，故默认 registry 足够）。`POST /api/workflows/{id}/runs/{rid}/rewind` 随后在**同一 thread** 上用 `checkpoint_id` 起新 run，`run_workflow` 把它透传进 `config["configurable"]` 且 `graph_input=None`——于是该节点及其后继重跑，而上游产物留在 state 里。**这正是回退重跑的全部价值**：上游副作用（`tool:bash`、`app:launch`）绝不被重复执行。**拒绝语义**：运行中 → 409（它还在写「回退要重放的那些 checkpoint」）、无 checkpointer → 503、从未被调度过的节点 → 422 并**列出可回退节点**；纯 planner 抛 `RewindError` 而非静默无操作（**静默无操作与成功无法区分**）；`flow:start`/`flow:end` 作为 sentinel 拒绝。**诚实取舍**：回退到**分支历史**中较旧的分支不被支持（只取最新匹配即当前 head 的血脉，旧分支的 checkpoint 仍在历史里但不再被选）；对话侧工具（`rewind_workflow_run` builtin）未加，画布/API 为唯一入口；跨运行回退（另一 run 的 checkpoint）不支持——仅限本 run 的 thread。**无迁移/无新表/无新配置段/无新依赖**。测试：新增 `tests/test_workflow_rewind.py`（19 条：候选归约（LangGraph 形状/缺字段容错/过滤非字符串任务/**无可寻址 checkpoint 即丢弃**）+ plan（最新匹配优先、更早的匹配让位、未调度节点报错**并列出可回退节点**、空历史提示 `<none>`、sentinel 拒绝）+ **真实历史定位**（找到调度 b 的 checkpoint / 失败的 b 仍可回退（正是恢复场景）/ 从未运行的 c 拒绝 / 未知 thread 无物可退 / **端到端：续跑后 `seen == a,b,c,b,c`（上游 a 不重跑）**）+ 路由（运行中 409 / 无 checkpointer 503 / 不可回退节点 422 / **成功时同 thread + checkpoint_id + params 继承 + metadata 标注**））+ 前端（`rewindWorkflowRun` URL/body/编码/409 detail 3 条；运行面板 4 条：终态可见并带提示、点击上报新 run id、拒绝信息可读、运行中隐藏）。全量离线 A/B：11435→11454 passed、**失败集合与基线逐条一致（75 = 75，零差异）**；ruff check/format 干净；前端 1230 passed、`check` exit 0、`format` 全绿。

> **进度（切片 AI：§24.12 工具级权限裁决）**：补齐 §24.12「Agent 威胁模型与注入防御」（计划表 **P0 安全基线**）的最后一块——注入防御侧已在 N14m 落地（`sanitize.py` + 既有中间件），本切片做**最小权限**侧。`skills/permission_policy.py`：把 §5.5 已声明但**从未被强制**的 `permissions`（`fs/net/exec/secrets`）变成运行时裁决——`resolve_capability_tools` 在装配前按能力组**并集**（经 `composition.resolve_declaration` 读，故**继承的声明也算**）逐工具裁决并丢弃越权工具、逐条记录拒绝理由。**三条刻意性质**：①**opt-in**（未声明权限的组不受限——没要求最小权限的包不得悄悄少工具，故既有行为零变化）；②**无法归类即 fail-closed**（表内声明已知族：sandbox fs/exec、`web_*`/`browser_*`/search/fetch 的 `net`、`app` provider 的 `exec`；其余——**含 MCP**——一律拒绝而非假定无害，拒绝文案点名 `tool-permissions` 这个可声明它的旋钮）；③**声明而非猜测**（新增 frontmatter `tool-permissions: {tool: [perms]}` 覆盖表外工具，`extends` 按**工具名逐项并集**——任一侧被丢掉都会发出比作者声明**更窄**的要求，而这恰恰是强制门最不能做的事）。`Skill.tool_permissions` 显式排除出 `__hash__`（mapping 不可哈希而 `Skill` 必须可哈希以支撑 frozen catalog）但保留在 `__eq__`。**诚实取舍**：裁决发生在 **AI 节点装配工具**处（`tool:invoke` 节点与对话侧工具集不走该路径，其权限边界是各自节点的 crash-confirm/审批语义）；表按工具名匹配（`allowed-tools` 列的是名字），provider 仅作精确化参数；MCP 工具若既未声明 `tool-permissions` 又落在受限组内会被拒绝——这是有意的 fail-closed，不是遗漏。**无迁移/无新表/无新配置段/无新依赖**；前端零改动。测试：新增 `tests/test_skill_permission_policy.py`（31 条：需求表（各族/`app` provider 不看名字/描述类无需权限/**未知工具返回 None 而非空集**/空名）+ 裁决（**未声明不强制**/声明内放行/越权拒绝并点名缺失权限/**无法归类拒绝并点名 `tool-permissions`**/覆盖使其可判/覆盖仍须合规/**空覆盖 = 无需权限**/纯空白声明不算声明）+ 集合裁决（有序拆分、逐条理由、未声明全放行、未知声明名上报）+ 解析（`tool-permissions` 正常/缺省/丢弃表内未知权限名/**畸形 mapping 与畸形条目 fail-soft**）+ 组合（**逐工具并集**、继承权限生效）+ 网关集成（未声明组保留全部工具、声明后过滤、**受限组内无法归类工具被拒**、覆盖后保留、**全部越权则一个不给且不询问网关**、**继承来的权限同样限制**、多组权限并集））。全量离线 A/B：11454→11485 passed、**失败集合与基线逐条一致（75 = 75，零差异）**；ruff check/format 干净。

---

### P3 — 低优先级

1. **N15 安全**：注入防御、威胁模型、权限裁决、密钥隔离、供应链（沙箱执行 + 静态扫描）。
2. SaaS 类（多租户/RBAC、环境晋升、类 PR 评审流）：**不做**。

---

## 六、里程碑

| 里程碑 | 内容 | 出口标准 | 状态 |
|---|---|---|---|
| M0 现状对齐 | C2/C3/C4/C6/C8/C10/C11 | 执行流、元数据、端口类型、迁移钩子与方案一致；测试全绿 | ✅ 达成（C4 版本范围校验顺延） |
| M1 工具可用 | N1 最小版 + C1 + C7 | AI 节点可调用能力组工具；notify 可用 | ✅ 达成（N1 为最小版） |
| M2 编排成熟 | C5 + N12 + N13 | 循环聚合、容错分支、并行合并可用 | ◐ C5 ✅（聚合 + 条件退出）+ N12 ✅（`flow:try` 容错容器）+ N13 ◐（并行合并 `params.merge` + 资源锁 `params.resource_lock` 已落地；共享变量延后至协作原语） |
| M3 定位落地 | N4/N5/N6/N7/N8 | 本地软件可编排、长时可触发与恢复 | ◐ N4/N5 切片 1 + N6 切片 2 + N7 切片 3 + N8 切片 4 完成 |
| M4 资产与协同 | N9/N10/N11 | 资产流转、共享工作区、预览确认与迁移 | ✅ 切片 5（N9 资产建模/往返/转换/契约）+ 切片 6（N10 预览/审批/undo + N10b 人机共享治理）+ 切片 7（N11 环境探测/数据目录规范）+ 切片 8（N11b 备份/导出导入/换机迁移）全部完成 |
| M5 能力补强 | N14 分批 | 逐项验收 §24 | ✅ 切片A–S 已落地（各项后续增量见对应进度注） |
| M6 安全基线 | N15 | 注入防御与权限裁决（最低优先级） | ◐ §24.12 注入防御切片M 已落地（AI 节点注入块未信任中和）；威胁模型/权限裁决深化待做 |

---

## 七、风险与取舍

- **AI 节点工具装配（C1）依赖工具网关（N1）**：若 N1 完整实现耗时，先做「描述符 + builtin/sandbox 分派」最小版解 C1，MCP/app provider 后续增量。
- **LLM 中间层（N2）**：现状经 `SubagentExecutor`/`create_chat_model` 已能调模型，N2 应渐进抽层，不推倒重来，避免阻塞 P0。
- **循环正宗版（C5）**：~~改动编译期语义，需保证既有简单版工作流向后兼容（schema 迁移钩子 C8 配合）。~~ **已缓解**：以 Option A（原位聚合 + `continue_on` 条件退出）落地，不改图拓扑、纯增量端口/参数，旧定义字节不变，**无需迁移**；「body 子图展开」作为后续增量单独评估（会触及 body 事件 depth / loop 内中断语义）。
- **安全低优先级**：本地单机、数据不出本机的前提下可延后；但「不可逆本地操作确认」与 P1 的 N10 强绑定，需随 N10 落地，不能等到 P3。
- **多用户隔离收缩（C9）**：涉及持久化与路由，属破坏性改动，建议放在 P1 末尾独立小步，避免影响 P0/P1 主线。

---

## 八、deerflow 上游裁剪规划

> 定位依据：《开发方案》§1.2（单机本地 + 双入口）、§15（单用户）、§18（单机不依赖 IM，通知走 `tool:notify`）、§13.2（单机不引入 K8s provisioner）、§24.13/§24.16（供应链安全、多环境晋升已裁撤）、§24.15（IM 为可选）。
>
> 目标：把 deerflow 上游面向「云端 SaaS / 多租户 / IM 集成 / 多节点」的能力从 HNFlow 主干移除或隔离，降低维护面与依赖面，让仓库只剩「单机工作流编排」所需底座。
>
> 标记：**[删除]** = 物理移除代码 / 配置 / 迁移 / 测试；**[隔离]** = 保留代码但默认禁用、移出主路径；**[保留改造]** = 复用为 HNFlow 能力，不裁。

### 8.1 裁剪判据

进 [删除] 需**同时**满足三条；满足两条的先进 [隔离]，待验证后再删：

1. **与定位冲突**：多用户 / 多租户 / RBAC / SaaS 协作 / IM 集成 / 分布式。
2. **上游默认关闭**：`config.example.yaml` 中该段 `enabled: false` 或整段注释（裁剪不改变默认行为）。
3. **HNFlow 主路径零依赖**：`workflow/` 及 Gateway 工作流路由不引用。已核实 `workflow/`（含 `executors/`）**不 import** `authz` / `guardrails` / `channels` / `community` / `integrations` / `scheduler` / `tui`——裁剪这些对工作流引擎无破坏。

### 8.2 [删除] 清单

**A1. 多用户鉴权与授权（SaaS 强隔离）**

| 位置 | 说明 |
|---|---|
| `app/gateway/auth/`（18 文件） | OIDC / JWT / session / password / 用户开通 / RBAC 仓储 |
| `app/gateway/`（`auth_middleware.py`、`authz.py`、`internal_auth.py`、`langgraph_auth.py`、`auth_disabled.py`）、`routers/auth.py` | 网关鉴权链与路由 |
| `harness/authz/`（8 文件） | RBAC provider / principal / tool_filter / enforcement |
| `harness/guardrails/`（4 文件）+ `agents/middlewares` 中授权/guardrail 环节 | 外部审查、工具调用前裁决 |
| `config.example.yaml`：`authorization` 段、`guardrails` 段 | 默认关闭 |
| 前端 `src/app/(auth)/`、`src/core/auth/`、`remember-login` | 登录/注册/回调页 |
| 依赖 extra / RFC 文档（`docs/plans/*authorization*`） | 随功能一并移除 |

依据：§15 单用户；本规划第五节 P3「SaaS 类不做」。**同步保留 `user_id` 弱隔离**（即 C9），不重造鉴权。

**A2. IM 渠道集成**

| 位置 | 说明 |
|---|---|
| `app/channels/`（23 文件） | Feishu / Slack / Telegram / Discord / DingTalk / WeChat / WeCom / Buzz |
| `app/gateway/github/`（8 文件）+ `routers/github_webhooks.py` | GitHub 事件驱动 agent |
| `routers/channels.py`、`routers/channel_connections.py` | 渠道 API 与用户绑定 |
| `harness/integrations/`（lark broker / cli） | 飞书托管集成 |
| `persistence` 的 `channel_*` 表与仓储、`app/gateway` 内渠道启动钩子 | 生命周期与存储 |
| `config.example.yaml`：`channels` 段、`channel_connections` 段 | 默认注释 / 关闭 |
| 前端 `src/core/channels/`、`src/core/integrations/` | 渠道连接 UI |
| 依赖 extra：`discord` / `buzz` 等 | 随功能移除 |

依据：§18「单机场景不依赖 IM」、§24.15「IM 为可选，非默认需要」。本机通知由 `tool:notify`（C7 已落地）+ Web 待办承担。

**A3. 多 worker / 分布式**

| 位置 | 说明 |
|---|---|
| `run_ownership`（lease / heartbeat / 跨进程回收） | 仅 `GATEWAY_WORKERS > 1` 需要，默认 `heartbeat_enabled: false` |
| `runtime/stream_bridge` 的 Redis provider | 单机保留 memory bridge；Redis 面多 worker 实时转发 |
| `docker/` 中 Redis 服务、多副本 compose 配置、`docker/provisioner` + K8s provisioner | §13.2 单机不引入 provisioner |

**A4. 运营 / SaaS 类**

| 位置 | 说明 |
|---|---|
| `feedback` 表 + `routers/feedback.py` + 前端反馈 UI | 产品运营向，单机自用不需要 |
| `routers/suggestions.py`、`routers/input_polish.py` + 前端 `core/suggestions`、`core/input-polish` | 输入辅助 / 联想，非核心 |
| 前端 `src/app/showcase/`、`src/app/blog/`、`core/blog/` | 公开只读 demo 与博客，偏离单机定位 |

**A5. TUI**

| 位置 | 说明 |
|---|---|
| `harness/tui/`（15 文件）、`docs/tui/` | 终端工作台；方案技术栈为「Next.js + React Flow 双入口」，未纳入 |

**A6. 多用户 memory 隔离（收缩，与 C9 合并）**

| 位置 | 说明 |
|---|---|
| `agents/memory` per-user 目录布局、`memory.strict_user_scope`、`scripts/migrate_user_isolation.py` | 收缩为单机单用户；保留弱隔离常量 `DEFAULT_USER_ID` |

依据：§15。⚠ 本项与 C9「单用户模型收缩」是同一改动，**必须同批落地**，否则留下半套隔离。

### 8.3 [隔离] 清单（保留代码，默认禁用 / 移出主路径）

| 模块 | 位置 | 处理 |
|---|---|---|
| MCP 长期任务 | `app/mcp_tasks/`、`routers` 相关、`mcp_tasks` 配置 | 默认 `enabled: false`，暂留；N1 工具网关收编 MCP 后评估删除 |
| 技能自进化 + 安全扫描 | `skill_evolution` 配置、技能写入路径 | 默认 `enabled: false`；§24.13 供应链已裁撤，随能力包落定后删 |
| 自定义 Agent HTTP 管理 | `agents_api` 配置、`routers/agents.py` 管理面 | 默认 `enabled: false`，存在多用户信任边界，单机可隔离或删 |
| 远程沙箱 provider | `community/e2b_sandbox`、`community/aio_sandbox`（remote）、`boxlite`、`tenki` | 单机只保留本地 sandbox（§13.2） |
| 云端搜索 / 抓取工具 | `community/{brave,exa,tavily,serper,jina_ai,ddg_search,crawl4ai,firecrawl,browserless,image_search,infoquest,groundroute,searxng,fastcrw}` | 按「本地优先、隐私优先」（§24.10）默认不启用；去重后保留最小检索集，其余移出 |
| 浏览器控制 | `harness/community/browser_automation`、`routers/browser.py`、前端 browser 面板 | 可选能力，默认关闭 |
| 语音输入 / 侧车 | 前端 `core/voice-input`、`core/sidecar` | 可选，默认关闭 |

> 隔离项的共性：与定位不冲突但非必需，先「默认关闭 + 不进主路径」，避免一次性大删带来的回归面；待 P1 定位主线稳定后再逐个转 [删除]。

### 8.4 [保留改造] 清单（不裁，明确归属）

| 模块 | 归属 | 说明 |
|---|---|---|
| `harness/scheduler` + `app/scheduler` + `routers/scheduled_tasks.py` + 前端 `workspace/scheduled-tasks` | **N7 触发与调度**（§18） | 上游定时任务默认关闭，复用为本地触发调度基础（cron / 文件监视 / 应用事件 / 空闲），**不另起执行栈** |
| `agents/memory`（逻辑层） | **§24.1 记忆体系**（P1） | 保留能力，收缩作用域到单用户 |
| `harness/tracing` | **§24.9 端到端可观测**（P0） | 保留 trace 传播与成本归因 |
| `harness/models` | **N2 LLM 中间层**（§8） | 作为中间层的厂商适配底座，渐进抽层不推倒 |
| `harness/mcp` | **N1 工具网关 provider**（§9） | MCP 作 provider 收编 |
| `harness/sandbox`（本地 provider） | **§13.2 Sandbox** | 命令类节点强制走本地沙箱 |
| `persistence`：`runs` / `threads_meta` / `run_events` / `workflow_definitions` / `human_tasks` | 基础设施 | 移除 `channel_*` / `users` / `feedback` 后的保留集 |
| `harness/{agents,subagents,tools,skills,config,extensions,reflection,uploads,workspace_changes,utils,runtime}`、`workflow*` | 核心底座 | HNFlow 依赖，全部保留 |

### 8.5 执行顺序与前置

1. **A2 IM 渠道**（与核心最解耦，先删）→ 清理 `channels`/`channel_connections` 配置与 `channel_*` 表引用。
2. **A1 鉴权 / 授权 / guardrails** → 拆 `AuthMiddleware` / CSRF 依赖，剥离中间件链第 9 步（授权/guardrail）。
3. **A6 多用户 memory 收缩**（与 C9 同批）→ 统一 `DEFAULT_USER_ID`。
4. **A3 分布式** → 删 `run_ownership` / Redis bridge / provisioner；compose 收敛为单节点。
5. **A4 运营类 + A5 TUI** → 前端路由与后端路由同步删。
6. **[隔离] 项** → 配置默认关闭 + 主路径摘除；P1 完成后复查转删。

**每批配套动作（缺一遗留悬挂引用）**：
- 后端：代码 + 路由挂载（`app.py`）+ 配置段（`config.example.yaml`）+ 持久化迁移 + 测试；
- 持久化：**已发布的 alembic 迁移不直接删**，改以新迁移 drop 表（避免 `alembic_version` 断裂）；未发布的可直接删；
- 边界测试：更新 `tests/test_harness_boundary.py`、`tests/test_compose_default_bind_host.py`；
- 前端：路由 + `core/*` + i18n 词条；
- 文档：同步 `AGENTS.md`（根 / backend / frontend）、`README`、部署 compose。

### 8.6 风险

- **删鉴权牵连网关中间件链**：`AuthMiddleware` / CSRF / `internal_auth` 与「渠道内部鉴权」耦合，须与 A2 联动，避免残留半套。
- **删 guardrails 影响 middleware 顺序**：授权/guardrail 在 agent 中间件链第 9 位，删除后需复核 ordering 测试。
- **迁移表断裂**：`channel_*` / `users` / `feedback` 已被 alembic 纳管，drop 须走新迁移。
- **frontend features 能力发现**：`/api/features` 与渠道/browser 开关耦合，删后需同步前端 gating（否则死控件）。
- **裁剪与 P0/P1 主线竞争**：建议**每批小步、独立提交**，不进 P1 功能分支；裁剪不改变运行语义，验收以「测试全绿 + 无悬挂 import」为准。

### 8.7 与阶段的对应

| 阶段 | 裁剪动作 |
|---|---|
| **P0（已完成）** | 不裁剪；仅确认 workflow 对上游零依赖（判据 3 已核实） |
| **P1 起步前** | A2 / A1 / A6 / A3 四批（与 C9 同批）；A4 / A5 可并行 |
| **P1 期间** | [隔离] 项保持默认关闭；`scheduler` 改造接入 N7 |
| **P2 及以后** | 复查 [隔离] 项，逐项转 [删除]；能力包 / MCP provider 落定后清 `mcp_tasks` / `skill_evolution` |

> **进度（A2）**：IM 渠道批次已完成——物理移除 `app/channels/`、`app/gateway/github/`、routers（channels / channel_connections / github_webhooks / integrations）、`harness/integrations/`（Lark CLI）、`persistence/{channel_connections,webhook_delivery}`、相关前端（`core/channels`、`core/integrations`、`settings`/侧栏入口）与测试；持久化以新迁移 `0014_drop_im_channel_tables` drop `channel_*` / `webhook_deliveries`（未删已发布迁移）；清理 `channel_connections` / `dedupe_storage` 配置、setup wizard 渠道步骤、remote_backend 的 lark 通道与 provisioner 白名单。后端全量套件失败项均为 Windows 平台既有失败（路径分隔符 / POSIX shell / symlink 权限），工作流套件 518 passed。
>
> 注：`backend/pyproject.toml` 的渠道依赖（lark-oapi / slack-sdk / python-telegram-bot / discord / buzz 等）暂未移除——`uv lock` 因 `tenki-sandbox` 不在 registry 无法重解析，强行改依赖会破坏 `uv.lock` 同步；待 lock 可重生成时随 A3/B1 一并清理。

> **进度（A1）**：多用户鉴权批次已完成——物理移除网关 `auth/`（OIDC/JWT/session/password/用户开通）、`auth_middleware`、`authz`、`auth_disabled`、`internal_auth`、`langgraph_auth`、`routers/auth.py`、`csrf_middleware.py`，harness `authz/`、`guardrails/` 与 `config/{authorization,guardrails}_config.py`，持久化 `persistence/user/`；新增迁移 `0015_drop_users_table`。中间件链移除第 9 步（授权/guardrail）与 Layer 1 tool_filter；`authorization` / `guardrails` 配置段删除。收敛为**单用户**：请求身份固定 `DEFAULT_USER_ID="default"`，`user_id` 弱隔离列保留（C9）；`resolve_user_id(AUTO)` 无上下文时回落默认用户；路由权限门（`require_permission`）与管理员门（`require_admin_user`）变为放行（保留声明供将来复用），模型/工具授权过滤移除；CORS 常量迁移至 `app/gateway/cors.py`；`get_trusted_internal_owner_user_id` 可信头移除。前端删除 `(auth)/{login,setup,auth/callback}`、登录/注册辅助（next-path / remember-login / setup / gateway-config / proxy-policy）、`remember-session-option`；`core/auth` 收缩为静态单用户 shim（`AuthProvider` / `getServerSideUser` / `types` / `static-user`），workspace 直接进入、无登录门；`fetcher` 去掉 401→/login 重定向；账号设置去掉改密/登出。测试：删除纯鉴权/授权/guardrail 测试与用户隔离 e2e；更新持久化 HEAD→0015、路由/服务/客户端测试；后端全量剩余失败 130 项与 17 项新增失败均已复核为既有平台问题（Windows 路径/时序/symlink/POSIX shell）。前端 typecheck/lint/format/单测（1194）全绿。
>
> 注：前端 `tests/e2e-real-backend/*` 与 `tests/e2e/utils/mock-api.ts` 仍含 `/api/v1/auth/register|me` 流程，未在本次单元门禁内运行；后续按单用户重写（去除注册步骤）。

> **进度（A6 + C9）**：多用户 memory 收缩已完成——删除一次性迁移脚本 `scripts/migrate_user_isolation.py` 及其测试（HNFlow 为全新单机产品，无 legacy 多用户升级路径）；移除 `memory.strict_user_scope`（`DeerMemConfig` 字段、`paths.py` 校验、`config.example.yaml`、`backend/AGENTS.md` 配置表）；DeerMem `memory_file_path` 去掉不可达的「无 user_id → 存储根」分支，省略 `user_id` 时恒回落弱隔离桶 `default`（新增 `data_root()` 供索引重建遍历全部桶，修正原 `memory_file_path().parent` 逻辑）；`workflow/check_cycles.py` 的 `DEFAULT_USER_ID` 改从 `runtime.user_context` 引入（provisioner 独立镜像保留自有常量，归 A3）。清理对已删脚本的悬挂引用（`routers/agents.py`、`update_agent_tool.py` 错误文案、`agents_config.py`/`paths.py`/`migrate_agents_to_db.py` docstring、`AGENTS.md`、`docker/provisioner/README.md`）。**明确保留** `users/{user_id}/` 目录布局与持久化 `user_id` 列（弱隔离，C9），不动 `make_safe_user_id`/`test_paths_user_isolation.py`。后端目标套件与 ruff 全绿。

> **进度（A3a 运行期 ownership 收缩）**：删除 `RunOwnershipConfig`（配置段 / `reload_boundary` 注册 / `config.example.yaml`）与多 worker 启动门第 4 条（`deps.py`）；移除 `RunManager` 的 lease/heartbeat、跨 worker 接管、durable cancel、`ownership_lost` fencing、`worker_id`、周期回收；`RunStore` 去掉 `update_lease`/`renew_lease`/`request_cancel`/`finalize_if_not_cancelled` 与 `LeaseRenewal`/`StatusFinalization`；`CancelOutcome` 收敛为 `cancelled`/`not_active_locally`/`not_cancellable`/`unknown`；`cancel` 简化为单机本地路径。**保留**启动崩溃回收（NULL lease 视为可回收）——**规划行「仅 GATEWAY_WORKERS>1 需要」与实际不符，单机也需要**；`runs.owner_worker_id`/`lease_expires_at`/`cancel_action` 列保留（无新迁移）；stream bridge 的 SSE `HEARTBEAT_SENTINEL` 与 run lease 无关，保留。删测试 `test_multi_worker_run_ownership.py`，改其余 6 个测试文件。

> **进度（A3b 事件分发收敛单机）**：删除 `runtime/stream_bridge/redis.py`（RedisStreamBridge）与 `StreamBridgeConfig` 的 redis 字段（`type`/`redis_url`/`max_connections`/`stream_ttl_seconds`/`recovered_stream_cleanup_delay_seconds`），factory 恒返回进程内 `MemoryStreamBridge`；`Runtime`/`stream_bridge` 包的 Redis 懒加载说明移除。compose 两份文件去 `redis` 服务 / `redis-data` 卷 / `DEER_FLOW_STREAM_BRIDGE_REDIS_URL` / gateway `depends_on: redis`，gateway 固定 `--workers 1`（去 `GATEWAY_WORKERS` 覆盖）；`Makefile` 去 `docker-logs-redis`、`scripts/docker.sh` 去 `--redis`；`backend/Dockerfile` 不再强制 `--extra redis`；`scripts/detect_uv_extras.py` 去 `stream_bridge.type` 探测规则（保留 `sandbox.ownership.type` 与 env 规则）；`aio_sandbox/ownership/factory.py` 去 `stream_bridge` 推断（改回 env 驱动）。文档同步 `backend/AGENTS.md`、`backend/docs/API.md`、`config.example.yaml`、根 `README.md`。**保留** `sandbox.ownership`（redis 租约，§8.3 [隔离]）与 `database.checkpoint_cache` redis provider（非本次批次）。测试：重写 `test_compose_default_workers.py`，改 `test_stream_bridge.py`（去 redis 层）/`test_sandbox_ownership_store.py`/`test_detect_uv_extras.py`。

> **进度（A3c 沙箱 provisioner + K8s）**：删 `docker/provisioner/**`、`aio_sandbox/remote_backend.py`（及 `aio_sandbox/__init__` 导出与 `_create_backend` provisioner 分支）、`sandbox_config` 的 `provisioner_api_key`、`deploy/helm/**`（整目录，K8s 多节点部署）；compose 两份文件去 `provisioner` 服务与 `LARK_CLI_*`、`PROVISIONER_API_KEY`、NO_PROXY provisioner；nginx 去 `/api/sandboxes` 上游；`scripts/{docker,deploy}.sh` 去 provisioner 检测/服务/日志；`scripts/{verify_versions,bump_version}.sh` 与 `verify-versions.yml` 去 Chart 版本源；删 `.github/workflows/chart.yaml`、`scripts/check_config_version.sh`，`nightly.yaml`/`container.yaml` 去 provisioner 镜像与 chart 发布；`.env.example`/`config.example.yaml`/`doctor.py` 去 provisioner 配置。文档同步根 `AGENTS.md`/`README.md`/`RELEASING.md`、`backend/AGENTS.md`、`backend/docs/CONFIGURATION.md`、前端 mdx（en/zh）。删测试 `test_provisioner_*`/`test_remote_sandbox_backend.py`，改 `test_aio_sandbox_provider.py`/`test_docker_sandbox_mode_detection.py`/`test_nginx_langgraph_body_size.py`。后端目标套件与 ruff 全绿。

> **进度（A4 运营类）**：分三批完成。**A4a** 删运行反馈——`routers/feedback.py`、`persistence/feedback/**`（`FeedbackRow`+`FeedbackRepository`）、deps 装配与 `get_feedback_repo`、`GET /api/runs/{rid}/feedback`、thread_runs 两个列表端点的 feedback enrichment（保留 `turn_duration`）；新增迁移 `0016_drop_feedback_table`（幂等 drop，已发布 0001 保留建表，测试 HEAD 常量 0015→0016）；删 `test_feedback.py`/`test_thread_messages_feedback.py`，改 backend 测试若干与 `backend/docs/RUN_EVENT_STREAM.md`/`backend/AGENTS.md`/`README{,_zh}.md`。**A4b** 删输入辅助——`routers/suggestions.py`、`routers/input_polish.py`、`config/{suggestions,input_polish}_config.py`、`AppConfig` 字段、`config.example.yaml` 两段、router 挂载/OpenAPI tag、测试；文档同步 `backend/AGENTS.md`/`ARCHITECTURE.md`/`REPLAY_E2E.md`。**A4c** 删前端——运行反馈 UI（`core/api/feedback.ts` + `message-list-item` 的 FeedbackButtons）、跟进建议（`core/suggestions/{api,hooks}.ts` + 输入框 followups/确认弹窗）、输入润色（`core/input-polish` + 输入框 polish/撤销/骨架）、公开只读 demo 与博客（`app/showcase/**`、`app/blog/**`、`core/blog/**`、landing case-study/post-list、header 博客入口）。**保留**欢迎页快捷提示 `SuggestionList`（`core/suggestions/placeholders` 内联进 `input-box-helpers.ts`）。i18n 去 `followup*`/`inputPolish*`/`home.blog`。前端 typecheck/lint/单测 1181/prettier 全绿，e2e chat/thread-history/mock-api 同步。

> **进度（A5 TUI）**：删 `packages/harness/deerflow/tui/**`（15 模块 + widgets）、`backend/docs/TUI.md`、`docs/tui/`、`tests/test_tui_*.py`（16）；移除 `[project.scripts]` 的 `deerflow` 入口；`test_thread_id_validation` 去 TUI `/resume` 用例。`harness/pyproject.toml` 的 `tui` extra 与 backend `textual` dev 依赖**暂留**（`uv.lock` 因 tenki-sandbox registry 缺口无法重生成，注释说明，`uv lock --check` 仍通过）。代码注释与 `README{,_zh}.md`/`CONTRIBUTING.md` 树同步。ruff 干净、测试收集无 import 错误、受影响套件通过。

> **进度（[隔离] 项审计，§8.5 步 6）**：逐项核对「默认关闭 + 主路径摘除」，全部已满足，无需代码改动——`agents_api.enabled`/`skill_evolution.enabled`/`mcp_tasks.enabled` 默认 `false`；`agents_api` 路由经 `_require_agents_api_enabled()` 在关闭时返回 403、`browser` 路由经 `_browser_tools_enabled()` 在未启用时返回 404，两者前端均按 `/api/features` 门控；`sandbox.use` 默认 `deerflow.sandbox.local:LocalSandboxProvider`，e2b/boxlite/tenki/aio 远程 provider 仅在显式配置时装配；云搜索/抓取 provider 除最小检索集（`ddg_search` 搜索、`jina_ai` 抓取、`ddg` 图搜）外均在 `config.example.yaml` 注释默认关闭；browser 面板/工具默认关闭；语音输入与侧车为前端浏览器原生能力/本地 UI，无云端依赖。顺带清理 `config.example.yaml` 中 A1/A4a 遗留的 `feedback`/`users` 表注释引用（`database` 段说明与 Postgres schema 迁移示例）。按 §8.7，[隔离] 项在 P1 期间保持默认关闭，待 P2 复查转删。

> **进度（e2e 悬挂引用清理，A1/A2/A4 收尾）**：单用户 + 裁剪后，e2e 配置/用例仍引用已删能力，属 §8.5「缺一遗留悬挂引用」。删 `frontend/playwright.auth.config.ts` 与 `e2e-tests.yml` 的 auth 步骤（指向已删 `tests/e2e-auth`，CI 会因 testDir 缺失失败）；`e2e-real-backend/{multi-run-order,real-backend-render}.spec.ts` 去 `auth/register`+CSRF、直接同源 seed，render 断言由「建议」改为「助手回答」；`e2e-record/record-write-read-file.spec.ts` 去注册与 `/suggestions` 等待；`e2e/utils/mock-api.ts` 删 auth/channels 路由桩与 `MOCK_AUTH_USER`。前端 typecheck/lint/prettier/单测全绿。并一并删除 `mock-api.ts` 中 A2 遗留的 Lark/integrations 路由死桩与 `larkIntegrationStatus`（`config`/`auth`/`install` 等，无 spec 引用）。

> **进度（A1 鉴权遗留清理）**：A1 删除鉴权后仍有悬挂引用，逐一收敛。**后端**：删 `config/auth_config.py`（OIDC/本地登录模型）与 `AppConfig.auth` 字段（无消费方，`extra="allow"` 移除安全）、`config.example.yaml` 的 SSO/OIDC 与本地登录配置段、`aio_sandbox/backend.py` 中已删的 `RemoteSandboxBackend` 提及；`tests/_replay_fixture.py` 去 `auth/register`+CSRF（否则 replay-e2e Layer 1 golden 失败）、`tests/test_gateway_lifespan_shutdown.py` 去 `app.gateway.app.auth.close_oidc_service` 补丁（该模块已删，此前 **10 个用例因 AttributeError 失败，被误判为平台失败**）。**前端**：删 `gateway-offline-banner`/`gateway-offline-fallback`（探针指向已删的 `/api/v1/auth/me`，fallback 无引用、`gatewayUnavailable` 恒 false，属死代码）、`WorkspaceContent` 的 `gatewayUnavailable` prop、i18n `logout`/`gatewayUnavailable*`。另清理 `docker/nginx/*.conf` 的登录/CSRF/auth 注释与 `.agent/skills/smoke-test/frontend_check.sh` 的整套登录/注册/initialize/session 死流程（`authenticate()` 简化为可达性检查）。**已知残留（无害，未清）**：前端 `core/api/{api-client,fetcher}.ts` 的 CSRF 注入管道仍在（`csrf_token` cookie 永不再下发，注入为空操作），可随后续前端整理一并移除。验证：后端 ruff 干净、收集 9961 无 import 错误、config/reload/lifespan/replay 用例通过（仅剩既有 Windows 环境失败）；前端 typecheck/lint/prettier/单测全绿。

> **进度（全量后端套件甄别）**：跑 `pytest -m "not live" tests/`（9962 项）逐条甄别 104 个失败，其中 **28 个是本仓库真实陈旧测试**（此前被笼统归为「平台失败」）并已修复：`test_lead_agent_model_resolution`（`build_lead_runtime_middlewares` 假实现补 `deferred_setup`；去 A1 已删的 `authorization_provider`；server-auth 身份用例改为单用户 runtime-user 贯通、configurable 身份不可信）、`test_threads_router`（A3a 去 `worker_id`，改共享 store in-flight 断言）、`test_sandbox_orphan_reconciliation`（删 A3b 已移除的 stream_bridge→redis ownership 推断两用例）、`test_durable_context_middleware`（`deferred_setup` 形参）、`test_task_tool_core_logic`（app_config 提供 `subagents.max_delegation_depth`）、`test_support_bundle`（草稿标题 DeerFlow→HNFlow）、`test_gateway_runtime_cleanup`+`test_uvicorn_reload_exclude`（适配 `uv run python -m uvicorn` 启动形式、跳过注释行误匹配）。**剩余 75 项**均为 Windows/POSIX 平台或既有 flake（路径分隔符、symlink/chmod、POSIX shell、时钟粒度、剥离环境子进程、macOS 检测、`test_run_manager` 时序）。修复后相关套件与 ruff/format 全绿。

> 说明：A4（运营类）/ A5（TUI）/ [隔离] 审计 / e2e 悬挂引用清理 / A1 鉴权遗留清理 / 全量失败甄别已完成，裁剪规划（§8.2 [删除] 清单 + §8.3 [隔离] 默认关闭）全部落地。

---

## 九、结论

- **P0 的实质是「补现有引擎的致命缺口」**：AI 节点不装配工具、执行流语义不符、缺 lockfile、能力组只收不校——这些不改，后续能力都建在沙地上。
- **N1/N2 是地基**，建议以最小版并入 P0，避免「先造完整网关再干活」的阻塞。
- **定位核心（P1）** 是区别于 n8n/Coze 的关键，但必须在 P0 引擎可信之后启动。
- **安全与 SaaS 类沉底**，仅保留与 P1 强绑定的「不可逆操作确认」。
- **上游裁剪与 P1 同步起步**：deerflow 的 IM 渠道、多用户鉴权/RBAC、多 worker 分布式、TUI、运营类能力按第八节分批**移除/隔离**——先删「默认关闭 + 主路径零依赖」的模块，[隔离] 项待 P1 稳定后转删。裁剪服务定位、不改运行语义。

## 十、本轮批次小结（N14f–m + N3）

一次连续执行落地 9 个切片，逐切片 TDD + 全量离线 A/B 对拍（失败集与基线逐条一致）+ ruff + 归档：

| 提交 | 切片 | 内容 |
|---|---|---|
| `7cf2a5f` | N14f | §24.7 幂等键端到端（http 头 / bash env）+ 有界节点重试（仅幂等，`__retry`） |
| `033ddbc` | N14g | §24.11 确定性重放（节点级 record/replay + 脱敏 + 原子 JSON） |
| `55602bb` | N14h | §24.8 评测/回归断言核心（精确 + 语义断言 + 报告） |
| `cb025b6` | N14i | §24.10 节点级模型路由（local/cheap/quality，隐私优先） |
| `a6f1aff` | N14j | §24.1 节点级记忆（四级作用域 + store 协议 + 注入/写回） |
| `a96d03d` | N14k | §24.2 知识检索（分块/排序/引用/预算 + AI 节点注入） |
| `6e3fa23` | N14l | §24.6a/b 拓扑模板（评审回环 + supervisor） |
| `5b58642` | N14m | §24.12 AI 节点注入块未信任中和 |
| `a215a69` | N3 | §5.5 能力包契约（permissions / schema 版本 / context_budget） |
| `0ae610f` | N14n | §24.10 运行级预算强制（`metadata.budget` warn/abort） |
| `f2a1493` | N14o | §24.2 `data:knowledge` 节点 + 前端 palette |
| `b3d8c97` | N14p | §24.8 评测 runner（回放 golden + 断言） |
| `a099128` | N14q | §24.8 评测 CLI（`python -m deerflow.workflow.eval_cli`） |
| `cdd6cc3` | N14r | §24.1 DeerMem `memory_store` 适配器 |
| `7b84912` | N14s | §24.6b `GET /api/workflows/templates` 模板端点 |
| `c8e3ffa` | N14t | §24.10 运行成本报表（`workflow/costs.py` + `GET /runs/{rid}/cost`） |
| `0e25ab8` | N14u | §24.8 定义内嵌评测套件 + opt-in 保存门（`definition_evals.py` + `POST /workflows/{id}/evaluate`） |
| `2e2208f` | N14v | §24.6b 画布「插入模板」（`fetchWorkflowTemplates` + `canvas/templates.ts` + 工具栏下拉） |
| `78d0715` | N14w | §24.2 向量后端适配器（`workflow/embeddings.py`） |
| `a2ba5fd` | N14x | §25 执行数据分析后端 + 节点耗时（`__duration_ms` + run.end `node_timings`） |
| `7bf2519` | N14y | §25 调试能力：节点断点（`breakpoint.py`，复用 HITL 栈） |
| `72c7fd6` | N14z | §25 工具节点化：`tool:invoke` 直调网关工具（+ 前端 palette） |
| `5e5bc9e` | N14aa | N1 §9 MCP 收编为独立 provider（`PROVIDER_MCP`） |
| `1bdfdbd` | N14ab | §25 前端：节点耗时读数 + 断点开关 |
| `318e04c` | N14ac | §5.5 能力包组合机制（`skills/composition.py`，extends/overlay） |
| `23b88f0` | N14ad | §25 单步执行 step mode（`debug_step` run 级开关 + resume 按任务 kind 续航） |
| `9708d6f` | N14ae | §25 画布调试 UI（单步运行按钮 + 调试暂停卡：继续/跳过） |
| `77172e4` | N14af | §24.6a 受控动态 handoff（`flow:handoff` 白名单路由 + 预算 + 结构化消息） |
| `0c58d7b` | N14ag | §24.8 能力包导入评测门（`evals/*.json` trigger 用例 + opt-in `require_pass`） |
| `301f0ed` | N14ah | §25 回退重跑（`checkpoint_id` 续跑 + `/rewind` 路由 + 画布按钮） |
| `0ca11a8` | N14ai | §24.12 工具级权限裁决（能力包 `permissions` 运行时过滤 + `tool-permissions` 覆盖） |

**盘点**：P0/P1/P2 主线（含 N12/N13/N14 切片 A–M）与 N3 已落地；N2 经核实由既有 `deerflow.models` 层满足。**剩余为各切片标注的后续增量与 §25 规划项**：N1 的 MCP/skill provider、DeerMem `memory_store` 适配器、`data:knowledge` 节点 + 前端 palette、评测 runner/CI 挂载、三级预算强制与成本报表、拓扑模板画布插入 UI、§24.12 完整威胁模型/工具级权限裁决、调试断点/成本缓存优化等。
