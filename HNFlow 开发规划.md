# HNFlow 开发规划

> 依据《HNFlow 开发方案》（唯一参考文档），对照当前代码现状，给出「基于旧版本改造 + 新增」的分阶段实施规划。
>
> **排序原则**：核心运行逻辑优先；安全等非核心项置于最低优先级。
>
> 标记：**[改造]** = 修改现有代码；**[新增]** = 全新模块；**[补齐]** = 现有占位实现落地。

---

## 一、现状盘点

### 1.1 已实现（旧版本）

| 模块 | 位置 | 状态 |
|---|---|---|
| 定义层 | `workflow/schema.py` | Port/Node/Edge/WorkflowDefinition/Metadata；NodeType 六类（flow/data/tool/ai/human/nested） |
| 校验与序列化 | `workflow/workflow_io.py` | 无环 DFS、单起止、端口引用/类型、params JSON 兼容、subworkflow spec 形状；`SCHEMA_VERSION=1` |
| 依赖图/循环检测 | `workflow/dependency_graph.py`、`check_cycles.py` | 三类引用聚合 + 全局 DFS |
| 编译层 | `workflow/compiler.py` | 定义→StateGraph；start/end 映射；if/switch 条件边；loop（简单版）；parallel；子图编译展开 + 运行期委派；编译缓存 |
| 执行器 | `workflow/executors/` | flow(if/switch/wait)、data(assign/convert/file/json/regex)、tool(bash/http/log)、ai(llm_agent)、human(task) |
| AI 节点 | `executors/ai.py` + `workflow/prompts.py` | 三层提示词（身份/能力/任务）；template/continue 双模式；经 `SubagentExecutor` 执行；token 用量聚合 |
| 人类节点 | `executors/human.py`、`human_task_state.py` | `interrupt()` 挂起 + `Command(resume=)` 恢复；状态机；幂等复用 |
| 执行 worker | `workflow/worker.py` | 复用 run 生命周期；`wf:node:started/completed/failed` 事件；run.end token_usage |
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
| `flow:loop` | 简单版：`iteration` + `out` 透传 | 正宗版：子图展开 + `results`/`last` 聚合 |
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
- **E. 低优先级/可删**：安全（注入防御/威胁模型/供应链）、SaaS 类（多租户/评审流/环境晋升）。

---

## 三、改造清单（基于旧版本）

| # | 改造项 | 位置 | 说明 |
|---|---|---|---|
| C1 | **AI 节点真实工具装配** | `executors/ai.py` | 现 `tools=[]`，capability_groups 只进提示词。需按 `allowed-tools` 并集经工具网关装配工具（依赖 C5）。**核心** |
| C2 | **流式执行对齐** | `workflow/worker.py` | 方案 §12 为 `astream(stream_mode=["updates","custom"])`；现状 `astream_events(v2)`。统一为方案语义，保留节点级事件。**核心** |
| C3 | **lockfile 落元数据** | `schema.py`(`WorkflowMetadata`)、保存路径 | 新增 `lockfile` 字段（模型/prompt/tool schema/MCP 版本/采样参数）。**核心** |
| C4 | **能力组解析→校验→加载** | `schema.collect_resolved_groups` + 新增服务 | `resolved_groups` 目前只收集；补存在性/版本范围校验与执行期加载。 |
| C5 | **循环正宗版** | `compiler.py`(`_loop_node_fn`) | 由简单计数改为子图展开 + 条件边 + `results`/`last` 聚合输出。 |
| C6 | **端口类型扩展** | `schema.PortType` | 增 `number`/`array`/`record`，同步 `workflow_io.ports_compatible` 与前端 `types.ts`/校验。 |
| C7 | **通知执行器补齐** | `executors/tool.py`(`exec_notify`) | 落地本机通知（长期运行需要）。 |
| C8 | **schema 迁移钩子** | `workflow_io._migrate_schema` | 现抛 `NotImplementedError`；建立 v→v+1 迁移链。 |
| C9 | **单用户模型收缩** | 定义/持久化/路由 | 去多用户强隔离，保留 `user_id` 弱隔离（§15）。 |
| C10 | **执行器注册 `idempotent` 修正** | `executors/__init__.py` | `ai:llm_agent`/`human:task`/`nested` 现标 `requires_confirmation=True`，与新语义（AI 有界自主 + 中断）对齐复核。 |
| C11 | **前端节点目录同步** | `node-catalog.ts`、`types.ts`、`validation.ts` | 与新增/改造节点（app、loop 端口、端口类型）保持一致；移除 `template_prompt`「future」占位语义。 |

---

## 四、新增清单

| # | 新增项 | 对应方案 | 说明 |
|---|---|---|---|
| N1 | 工具网关 | §9 | 统一描述符 + 调用信封 + provider（builtin/skill/sandbox/mcp/app） |
| N2 | LLM 中间层 | §8 | 统一模型接口/厂商适配/能力归一/路由/计量 |
| N3 | 能力包契约 | §5.5 | permissions/evals/tool_schema_version/context_budget/required-secrets |
| N4 | **本地软件接入层** | §17 | 应用注册表 + 实例/会话管理 + 驱动矩阵 + 人机共享 |
| N5 | `app` 类节点 | §6.7 | `app:launch/script/wait/collect` |
| N6 | 长期实例管理 | §18 | 实例列表/状态/恢复/归档/清理 |
| N7 | 触发与调度 | §18 | cron/文件监视/应用事件/空闲 + 幂等/去重/退避/DLQ |
| N8 | 本地资源治理 | §19 | GPU/CPU/内存/磁盘、License 并发、独占锁 |
| N9 | 文件/资产/跨软件契约 | §20 | 资产建模、格式转换、跨软件引用约定 |
| N10 | 人机共享工作区 + 预览 undo | §21 | 状态同步/抢占、不可逆操作确认、应用原生 undo |
| N11 | 环境探测 / 备份迁移 | §22 | 软件/插件/运行时探测、数据目录规范 |
| N12 | 容错编排 | 后续规划 | Try-Catch/Finally 节点、失败降级/回调 |
| N13 | 并发治理 | 后续规划 | 并行分支合并规则、共享变量、资源锁 |
| N14 | §24 Agent 能力补强 | §24 | 记忆/RAG/上下文策略/结构化输出/自主度/协作/事务/评测/可观测/重放/成本 |
| N15 | 安全基线与注入防御 | §24.12 | 注入防御、权限裁决、密钥隔离（低优先级） |

---

## 五、分阶段实施规划

### P0 — 核心运行逻辑（先做）

目标：让现有引擎真正跑通方案语义，AI 节点可实际调用工具。

1. **C1 AI 节点工具装配**（依赖 N1 最小版）
   - 先落地工具网关最小版（N1：描述符 + builtin/sandbox provider 分派），再让 `exec_llm_agent` 按 `capability_groups` 的 allowed-tools 并集装配 `tools`。
2. **C2 执行流对齐**：worker 改用 `astream(stream_mode=["updates","custom"])`，节点事件语义与方案一致。
3. **C3 lockfile + C4 能力组校验/加载**：`WorkflowMetadata.lockfile`；保存时固化、执行时按 lockfile 恢复。
4. **C5 循环正宗版 + C6 端口类型扩展 + C11 前端同步**。
5. **C7 通知执行器 + C8 schema 迁移钩子 + C10 幂等标注复核**。

验收：一个含 AI 节点调用工具、含循环聚合、含端口类型校验的端到端工作流可编译、执行、断点、恢复。

> 注：N2（LLM 中间层）与 N1（工具网关）是上层一切能力的地基。建议 **N2/N1 最小版并入 P0**，完整 provider/适配器随用随扩。

### P1 — 定位核心（本地专业软件 + 长期运行）

1. **N4 本地软件接入层**（应用注册表 / 实例会话 / 驱动矩阵 / 共享）。
2. **N5 `app` 类节点**（launch/script/wait/collect）+ tool 网关 `app` provider。
3. **N6 长期实例管理** + **N7 触发与调度**（cron/文件监视/应用事件，幂等/DLQ）。
4. **N8 本地资源治理**（GPU/内存/磁盘、License 并发、独占锁）。
5. **N9 文件/资产 + 跨软件契约**。
6. **N10 人机共享工作区 + 预览 undo**（对接应用原生 undo）。
7. **N11 环境探测 / 数据目录 / 备份迁移**。

验收：Blender/Unity/PS 等本地软件可被注册、拉起/附加、脚本驱动、产物回收；长时任务可由事件触发并跨重启恢复。

### P2 — 编排增强 + Agent 能力（分批）

1. **N12 容错编排**（Try-Catch/Finally、降级/回调）。
2. **N13 并发治理**（并行合并规则、共享变量、资源锁）。
3. **N14 §24 中与定位强相关项优先**：上下文策略(#3)、结构化输出(#4)、自主度预算(#5)、协作原语(#6a)、事务/undo(#7)、确定性重放(#11)、可观测(#9)、成本治理(#10)、记忆(#1)、检索(#2)、协作拓扑模板(#6b)。

### P3 — 低优先级

1. **N15 安全**：注入防御、威胁模型、权限裁决、密钥隔离、供应链（沙箱执行 + 静态扫描）。
2. SaaS 类（多租户/RBAC、环境晋升、类 PR 评审流）：**不做**。

---

## 六、里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M0 现状对齐 | C2/C3/C4/C6/C8/C10/C11 | 执行流、元数据、端口类型、迁移钩子与方案一致；测试全绿 |
| M1 工具可用 | N1 最小版 + C1 + C7 | AI 节点可调用能力组工具；notify 可用 |
| M2 编排成熟 | C5 + N12 + N13 | 循环聚合、容错分支、并行合并可用 |
| M3 定位落地 | N4/N5/N6/N7/N8 | 本地软件可编排、长时可触发与恢复 |
| M4 资产与协同 | N9/N10/N11 | 资产流转、共享工作区、预览确认与迁移 |
| M5 能力补强 | N14 分批 | 逐项验收 §24 |
| M6 安全基线 | N15 | 注入防御与权限裁决（最低优先级） |

---

## 七、风险与取舍

- **AI 节点工具装配（C1）依赖工具网关（N1）**：若 N1 完整实现耗时，先做「描述符 + builtin/sandbox 分派」最小版解 C1，MCP/app provider 后续增量。
- **LLM 中间层（N2）**：现状经 `SubagentExecutor`/`create_chat_model` 已能调模型，N2 应渐进抽层，不推倒重来，避免阻塞 P0。
- **循环正宗版（C5）**：改动编译期语义，需保证既有简单版工作流向后兼容（schema 迁移钩子 C8 配合）。
- **安全低优先级**：本地单机、数据不出本机的前提下可延后；但「不可逆本地操作确认」与 P1 的 N10 强绑定，需随 N10 落地，不能等到 P3。
- **多用户隔离收缩（C9）**：涉及持久化与路由，属破坏性改动，建议放在 P1 末尾独立小步，避免影响 P0/P1 主线。

---

## 八、结论

- **P0 的实质是「补现有引擎的致命缺口」**：AI 节点不装配工具、执行流语义不符、缺 lockfile、能力组只收不校——这些不改，后续能力都建在沙地上。
- **N1/N2 是地基**，建议以最小版并入 P0，避免「先造完整网关再干活」的阻塞。
- **定位核心（P1）** 是区别于 n8n/Coze 的关键，但必须在 P0 引擎可信之后启动。
- **安全与 SaaS 类沉底**，仅保留与 P1 强绑定的「不可逆操作确认」。
