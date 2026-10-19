# HNFlow 架构改造方案与进度

> 目标架构见 [`HNFlow 开发方案.md`](../../HNFlow%20开发方案.md)。
>
> 本文件是改造的执行清单：每一项包含证据、动作、验收和状态。状态只允许在**代码/测试实际完成后**更新为 `done`。
>
> 状态：`todo` / `in_progress` / `blocked` / `done`

## 0. 改造原则

- 不重写 LangGraph 执行内核；先把运行时装配和契约收口。
- 默认单进程、模块化单体；Agent/Sandbox/App 的进程边界按需再加。
- 所有新增能力先有契约与测试，再接 UI/工具。
- 每个阶段独立提交，提交前跑聚焦测试；全量测试按并行/聚焦策略执行。

## 1. 测试耗时治理

### 1.1 现状

- `backend/` 共 551 个 `test_*.py` 文件、11,683 个可收集测试（`-m "not live"`）。
- 仅收集就需要约 60 秒；`make test` 使用 `-v`，输出本身也是成本。
- `pytest-xdist` 未声明在依赖中；本地安装后，81 个 workflow 测试文件（1,332 个测试）串行约 38 秒，`-n 4/8 --dist loadfile` 约 29-33 秒。

### 1.2 措施

- [x] `make test` 改为 `-q`，新增 `make test-verbose`。
- [x] 新增 `make test-workflow`：只跑 `tests/test_workflow_*.py`，作为改造期间的快速回归集。
- [x] 新增 `make test-parallel`：`-n auto --dist loadfile`，保留文件级串行，降低单例/事件循环互相污染。
- [x] 文档记录 `pytest-xdist` 的本地安装方式（当前 workspace lock 被 `tenki-sandbox` 索引缺口阻塞，暂不写进锁文件）。
- [ ] 后续：给 CI 增加 workflow 聚焦 job；全量 job 使用 `-n auto --dist loadfile`。
- [ ] 后续：为最慢的 20 个测试文件建立耗时基线，禁止无意识回归。

**验收**：改造期间默认跑 `make test-workflow`；提交前至少跑一次相关测试文件；全量回归使用 `make test-parallel`。

## 2. 阶段一：运行时装配收敛（P0）

### 2.1 唯一编译上下文

- [x] `workflow/runtime_context.py`：提供 `build_workflow_compile_context(...)`。
- [x] worker 使用完整 `CompileContext`：`executors` + `previews` + `idempotent_by_type` + `checkpointer` + `definition_resolver` + 深度限制。
- [ ] eval_runner / rewind 复用同一工厂（eval_runner 已使用完整 `build_context()`；rewind 仍保留自有 executors 参数，后续收敛）。
- [x] 测试：真实 `run_workflow` 中 `require_approval` 能编译并挂起；幂等节点 `params.retry` 能编译并重试（装配契约测试 + approval/retry 既有测试）。

**证据**：`workflow/worker.py:163-170` 只取了 `build_context().executors`，导致 `require_approval` 与 `params.retry` 在真实路径不可用。

### 2.2 唯一运行时上下文

- [x] `workflow/runtime_context.py`：提供 `build_workflow_runtime_context(record, ctx, ...)`。
- [x] 注入 `user_id`（来自 `record.user_id`）、`tool_gateway`、`APP_RUNTIME_CONTEXT_KEY`、`APP_INSTANCE_REPO_CONTEXT_KEY`、`memory_store`/`knowledge_store`/`notifier`（存在时）。
- [x] worker、resume、rewind、continue、scheduler、对话工具统一使用（全部经 `run_workflow` 的同一装配；入口仍有两套调用代码，见阶段五）。
- [x] 测试：真实 worker 创建 `human:task` 后，任务 owner 为 `default`（`test_workflow_human_task_worker.py`）。
- [ ] 后续测试：`tool:invoke` 在真实 worker 中解析 builtin 工具；`app:launch` 写入实例记录。

**证据**：`workflow/worker.py:173-229` 未注入 `user_id`；`executors/human.py:67`、`approval.py:198`、`breakpoint.py:139` 生成 `user_id=""` 任务；`executors/tool.py:345-351` 因缺 `tool_gateway` 直接失败。

### 2.3 AI 提示词去重

- [x] 模板模式：system = identity/capability/examples/context/schema；task = 仅 task layer。
- [x] 测试断言 task 文本只出现一次，HumanMessage 不包含 identity/capability。

**证据**：`executors/ai.py:311-324` 将完整系统提示词赋给 `task_prompt`，`SubagentExecutor` 又把它作为 HumanMessage。

### 2.4 同步 IO 离事件循环

- [x] `_resolve_executor` 对同步 executor 统一 `asyncio.to_thread`。
- [x] `exec_file` 的 sandbox 读写用 `to_thread`。
- [x] previewer 的同步指纹 IO 用 `to_thread`。
- [x] `tests/blocking_io/` 增加 workflow executor 锚点（`test_workflow_executor_offload.py`）。

**证据**：`compiler.py:534-548` 直接调用同步 executor；`executors/tool.py:41-78`、`executors/data.py:153-202` 在事件循环上做阻塞 IO。

## 3. 阶段二：状态与可观测（P0）

### 3.1 `/state`、`/cost` 修复

- [x] 不再读取不存在的 `snapshot.channel_values`；优先 `run.end`，再读 `snapshot.checkpoint["channel_values"]`，最后编译图 materialize。
- [x] full/delta 两种模式都能返回运行状态与 per-node token usage（delta 走编译图 materialize）。
- [x] 测试：`run.end` 快照读取、成本路由、既有 route 测试通过；full/delta 端到端一致性仍需补一条专门测试。

**证据**：`workflow_run_routes.py:420-435`、`460-468` 读取 `CheckpointTuple.channel_values`，实际字段不存在；delta 下必须 materialize。

### 3.2 `run.end` 终态一致性

- [x] 终态状态修正：取消/挂起不再把 `run.end.metadata.status` 写成 `success`；错误路径补写 `run.end`。
- [ ] 抽出唯一 `finalize_workflow_run`（当前仍是 worker 内联逻辑）。
- [ ] `run.end` 内容限长/脱敏，不直接写完整 state。
- [ ] 测试：四种终态事件结构一致，token/timing 不丢失。

## 4. 阶段三：定义修订与元数据契约（P1）

### 4.1 不可变修订 + run 钉住

- [x] run 记录 `definition` 快照 + `definition_hash`（过渡方案，存于 run kwargs）。
- [x] resume/rewind/continue 优先加载 run 钉住的快照，legacy run 才回退当前行。
- [x] 新增 `workflow_definition_revisions` 表/仓储/迁移；保存产生新 revision。
- [ ] run 记录 `definition_revision_id`（当前仍用 kwargs 快照；表格已具备，接线待做）。
- [ ] 模板按 `(template_id, version)` 解析。
- [ ] DB 读取走 schema migration 链。
- [x] 测试：快照 hash/round-trip、malformed snapshot 回退；revision 递增/不可变/删除清理。

### 4.2 metadata 契约

- [x] `WorkflowMetadata.canvas` 显式声明。
- [ ] 明确 `definition.metadata`（运行语义）与 row `metadata`（系统快照）的边界。
- [ ] 删除 gateway/harness 重复的 `_resolve_workflow_metadata`。
- [x] 测试：`metadata.canvas` 通过 Pydantic 校验并 round-trip。
- [ ] 端到端测试：画布保存 → 重新加载 → 位置还原。

**证据**：前端 `mapping.ts:156` 写入 `metadata.canvas`，后端 `WorkflowMetadata` `extra="forbid"` 且无该字段，保存会 422。

### 4.3 保存时语义校验

- [ ] 每种节点类型定义 ParamModel。
- [x] 保存路由调用共享语义校验器（dry-run compile；审批/重试/上下文策略等编译期规则提前到保存）。
- [ ] 前端校验由后端 schema 生成。
- [x] 测试：语义非法定义在保存时返回 422（`test_create_rejects_semantically_invalid_definition`）。

## 5. 阶段四：AgentPort（P1）

- [x] 新增 `workflow/agent_port.py`：`AgentManifest`、`AgentTurnRequest`、`AgentTurnResult`、`AgentPort`、能力常量 T0-T5。
- [x] 新增 `DeerFlowAgentAdapter`，包装现有 `SubagentExecutor`。
- [x] `exec_llm_agent` 只依赖 AgentPort（`get_agent_adapter`），不再直接构造 `SubagentExecutor`。
- [x] 运行期检查节点所需能力（当前至少 `tools`；resume/assets 待扩展）。
- [x] 测试：默认适配器行为不变；fake 外部适配器能完成 T0/T1 节点（`test_workflow_agent_port.py`）。

## 6. 阶段五：双入口与前端契约（P1/P2）

- [ ] 唯一 `WorkflowRunService`：Gateway 与 dispatch 不再各写一套。
- [ ] 唯一 `run` 事件契约；前端类型/校验由 schema 生成。
- [ ] 拆分 `compiler.py` / `services.py` 的过载职责。
- [ ] 有界编译缓存 + 版本失效。

## 7. 进度表

| 阶段 | 内容 | 状态 | 提交 |
|---|---|---|---|
| 1 | 测试耗时治理 | done | 7db7ec4 |
| 2 | 运行时装配收敛 | done | 891ad02 |
| 3 | 状态与可观测 | in_progress | 891ad02 |
| 4 | 定义修订与 metadata | in_progress | 42969fd |
| 5 | AgentPort | done | 57c8d67 |
| 6 | 双入口/前端契约/拆分 | todo | - |

## 8. 提交记录

| 提交 | 内容 |
|---|---|
| 7db7ec4 | docs: 重写开发方案并建立改造跟踪 + test 目标优化 |
| 891ad02 | refactor(workflow): 运行时装配收敛、提示词去重、IO offload、state/cost、run 快照 |
| 57c8d67 | refactor(workflow): AgentPort + 默认 DeerFlow 适配器 |
| 42969fd | feat(workflow): 定义修订持久化 + 保存时 dry-run compile 校验 |

## 9. 验收清单（全部完成时）

- [ ] `make test-workflow` 全绿。
- [ ] `make test-blocking-io` 全绿。
- [ ] full/delta 下 workflow state/cost 一致。
- [ ] 真实 worker 的人工任务、审批、断点、tool:invoke 可用。
- [ ] 修改定义后 resume/rewind 仍使用 run 钉住的修订。
- [ ] 画布保存不再因 `metadata.canvas` 422。
- [ ] 前端不再手写与后端漂移的校验规则。
- [ ] AgentPort 默认适配器行为与改造前一致。
