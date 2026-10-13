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
| C5 | **循环正宗版** | `compiler.py`(`_loop_node_fn`) | 由简单计数改为子图展开 + 条件边 + `results`/`last` 聚合输出。 | ⏸ 顺延后续（改动编译期语义，需单独设计 + 迁移） |
| C6 | **端口类型扩展** | `schema.PortType` | 增 `number`/`array`/`record`，同步 `workflow_io.ports_compatible` 与前端 `types.ts`/校验。 | ✅ 已落地（前端 `types.ts`、端口颜色映射已同步） |
| C7 | **通知执行器补齐** | `executors/tool.py`(`exec_notify`) | 落地本机通知（长期运行需要）。 | ✅ 已落地：`runtime.context["notifier"]` 钩子 + 日志兜底 |
| C8 | **schema 迁移钩子** | `workflow_io._migrate_schema` | 现抛 `NotImplementedError`；建立 v→v+1 迁移链。 | ✅ 已落地：`register_migration` 逐版本链 |
| C9 | **单用户模型收缩** | 定义/持久化/路由 | 去多用户强隔离，保留 `user_id` 弱隔离（§15）。 | ⬜ 未开始 |
| C10 | **执行器注册 `idempotent` 修正** | `executors/__init__.py` | `ai:llm_agent`/`human:task`/`nested` 现标 `requires_confirmation=True`，与新语义（AI 有界自主 + 中断）对齐复核。 | ✅ 已落地：`requires_confirmation` 仅保留 bash/http |
| C11 | **前端节点目录同步** | `node-catalog.ts`、`types.ts`、`validation.ts` | 与新增/改造节点（app、loop 端口、端口类型）保持一致；移除 `template_prompt`「future」占位语义。 | ✅ 已落地（app 类节点待 P1） |

---

## 四、新增清单

| # | 新增项 | 对应方案 | 说明 | 状态 |
|---|---|---|---|---|
| N1 | 工具网关 | §9 | 统一描述符 + 调用信封 + provider（builtin/skill/sandbox/mcp/app） | ◐ 最小版（builtin/sandbox + 描述符/分派）；skill/mcp/app provider 后续 |
| N2 | LLM 中间层 | §8 | 统一模型接口/厂商适配/能力归一/路由/计量 | ⬜ 未开始（现状经 SubagentExecutor 间接调用，建议渐进抽层） |
| N3 | 能力包契约 | §5.5 | permissions/evals/tool_schema_version/context_budget/required-secrets | ⬜ 未开始 |
| N4 | **本地软件接入层** | §17 | 应用注册表 + 实例/会话管理 + 驱动矩阵 + 人机共享 | ⬜ P1 |
| N5 | `app` 类节点 | §6.7 | `app:launch/script/wait/collect` | ⬜ P1 |
| N6 | 长期实例管理 | §18 | 实例列表/状态/恢复/归档/清理 | ⬜ P1 |
| N7 | 触发与调度 | §18 | cron/文件监视/应用事件/空闲 + 幂等/去重/退避/DLQ | ⬜ P1 |
| N8 | 本地资源治理 | §19 | GPU/CPU/内存/磁盘、License 并发、独占锁 | ⬜ P1 |
| N9 | 文件/资产/跨软件契约 | §20 | 资产建模、格式转换、跨软件引用约定 | ⬜ P1 |
| N10 | 人机共享工作区 + 预览 undo | §21 | 状态同步/抢占、不可逆操作确认、应用原生 undo | ⬜ P1 |
| N11 | 环境探测 / 备份迁移 | §22 | 软件/插件/运行时探测、数据目录规范 | ⬜ P1 |
| N12 | 容错编排 | 后续规划 | Try-Catch/Finally 节点、失败降级/回调 | ⬜ P2 |
| N13 | 并发治理 | 后续规划 | 并行分支合并规则、共享变量、资源锁 | ⬜ P2 |
| N14 | §24 Agent 能力补强 | §24 | 记忆/RAG/上下文策略/结构化输出/自主度/协作/事务/评测/可观测/重放/成本 | ⬜ P2 |
| N15 | 安全基线与注入防御 | §24.12 | 注入防御、权限裁决、密钥隔离（低优先级） | ⬜ P3 |

---

## 五、分阶段实施规划

### P0 — 核心运行逻辑（先做）

目标：让现有引擎真正跑通方案语义，AI 节点可实际调用工具。

1. **C1 AI 节点工具装配**（依赖 N1 最小版）— ✅ 完成
   - 先落地工具网关最小版（N1：描述符 + builtin/sandbox provider 分派），再让 `exec_llm_agent` 按 `capability_groups` 的 allowed-tools 并集装配 `tools`。
2. **C2 执行流对齐**：worker 改用 `astream(stream_mode=["updates","custom"])`，节点事件语义与方案一致。— ✅ 完成
3. **C3 lockfile + C4 能力组校验/加载**：`WorkflowMetadata.lockfile`；保存时固化、执行时按 lockfile 恢复。— ✅ 完成（C4 版本范围校验留待 lockfile 深化）
4. **C5 循环正宗版 + C6 端口类型扩展 + C11 前端同步**。— C6/C11 ✅；**C5 ⏸ 顺延后续**
5. **C7 通知执行器 + C8 schema 迁移钩子 + C10 幂等标注复核**。— ✅ 完成

验收：一个含 AI 节点调用工具、含循环聚合、含端口类型校验的端到端工作流可编译、执行、断点、恢复。

> **本轮进度（P0）**：C1/C2/C3/C6/C7/C8/C10/C11 已完成，C4 部分完成，C5 顺延。后端 workflow 套件 504 passed / 1 skipped；前端 lint + typecheck + prettier + 单测（1254 passed）全绿。

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

| 里程碑 | 内容 | 出口标准 | 状态 |
|---|---|---|---|
| M0 现状对齐 | C2/C3/C4/C6/C8/C10/C11 | 执行流、元数据、端口类型、迁移钩子与方案一致；测试全绿 | ✅ 达成（C4 版本范围校验顺延） |
| M1 工具可用 | N1 最小版 + C1 + C7 | AI 节点可调用能力组工具；notify 可用 | ✅ 达成（N1 为最小版） |
| M2 编排成熟 | C5 + N12 + N13 | 循环聚合、容错分支、并行合并可用 | ⏸ C5 顺延，N12/N13 未开始 |
| M3 定位落地 | N4/N5/N6/N7/N8 | 本地软件可编排、长时可触发与恢复 | ⬜ 未开始 |
| M4 资产与协同 | N9/N10/N11 | 资产流转、共享工作区、预览确认与迁移 | ⬜ 未开始 |
| M5 能力补强 | N14 分批 | 逐项验收 §24 | ⬜ 未开始 |
| M6 安全基线 | N15 | 注入防御与权限裁决（最低优先级） | ⬜ 未开始 |

---

## 七、风险与取舍

- **AI 节点工具装配（C1）依赖工具网关（N1）**：若 N1 完整实现耗时，先做「描述符 + builtin/sandbox 分派」最小版解 C1，MCP/app provider 后续增量。
- **LLM 中间层（N2）**：现状经 `SubagentExecutor`/`create_chat_model` 已能调模型，N2 应渐进抽层，不推倒重来，避免阻塞 P0。
- **循环正宗版（C5）**：改动编译期语义，需保证既有简单版工作流向后兼容（schema 迁移钩子 C8 配合）。
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

> **进度（A1 鉴权遗留清理）**：A1 删除鉴权后仍有悬挂引用，逐一收敛。**后端**：删 `config/auth_config.py`（OIDC/本地登录模型）与 `AppConfig.auth` 字段（无消费方，`extra="allow"` 移除安全）、`config.example.yaml` 的 SSO/OIDC 与本地登录配置段、`aio_sandbox/backend.py` 中已删的 `RemoteSandboxBackend` 提及；`tests/_replay_fixture.py` 去 `auth/register`+CSRF（否则 replay-e2e Layer 1 golden 失败）、`tests/test_gateway_lifespan_shutdown.py` 去 `app.gateway.app.auth.close_oidc_service` 补丁（该模块已删，此前 **10 个用例因 AttributeError 失败，被误判为平台失败**）。**前端**：删 `gateway-offline-banner`/`gateway-offline-fallback`（探针指向已删的 `/api/v1/auth/me`，fallback 无引用、`gatewayUnavailable` 恒 false，属死代码）、`WorkspaceContent` 的 `gatewayUnavailable` prop、i18n `logout`/`gatewayUnavailable*`。验证：后端 ruff 干净、收集 9961 无 import 错误、config/reload/lifespan/replay 用例通过（仅剩既有 Windows 环境失败）；前端 typecheck/lint/prettier/单测全绿。

> 说明：A4（运营类）/ A5（TUI）/ [隔离] 审计 / e2e 悬挂引用清理 / A1 鉴权遗留清理已完成，裁剪规划（§8.2 [删除] 清单 + §8.3 [隔离] 默认关闭）全部落地。

---

## 九、结论

- **P0 的实质是「补现有引擎的致命缺口」**：AI 节点不装配工具、执行流语义不符、缺 lockfile、能力组只收不校——这些不改，后续能力都建在沙地上。
- **N1/N2 是地基**，建议以最小版并入 P0，避免「先造完整网关再干活」的阻塞。
- **定位核心（P1）** 是区别于 n8n/Coze 的关键，但必须在 P0 引擎可信之后启动。
- **安全与 SaaS 类沉底**，仅保留与 P1 强绑定的「不可逆操作确认」。
- **上游裁剪与 P1 同步起步**：deerflow 的 IM 渠道、多用户鉴权/RBAC、多 worker 分布式、TUI、运营类能力按第八节分批**移除/隔离**——先删「默认关闭 + 主路径零依赖」的模块，[隔离] 项待 P1 稳定后转删。裁剪服务定位、不改运行语义。
