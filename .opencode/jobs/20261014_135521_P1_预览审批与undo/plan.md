# N10 计划：预览 / 审批 / undo（P1 切片 6）

> 依据：《HNFlow 开发方案》§21（人机共享工作区与预览 / 审批 / undo）、§17（人机共享）、§十二 幂等/确认、《HNFlow 开发规划》§四 N10 行 / §五 P1 第 6 项。
> 状态：**已完成（S1–S8）**，提交 226e89。
> 前置：切片 1–5（N4–N9）已提交（HEAD `269b215` + 归档 `b9832ac`）。

## 1. 范围

**做**：不可逆操作的**可逆化**——动作预览（preview）→ 人工审批（approval，复用 HumanTask + interrupt）→ 执行前复验（staleness guard，复用 N9 资产指纹）→ 补偿与撤销（undo：文件级备份回滚 + 应用原生 undo 后备）。

**不做**（留后续切片，见开放问题 Q1）：
- 人在软件中操作的**主动探测**（presence 心跳）、抢占（preempt）语义、跨进程会话占用表——`attach` 模式 + `exclusive` 已在 N4 提供基本形态，其治理增强列为 N10b。
- 应用原生命中率的真实实现（驱动 `undo` 走「有则用、无则文件级备份」的后备协议，cli 驱动声明 unsupported）。
- 前端审批/撤销 UI（前端至今无 human-task 页面；本切片只做后端 + 最小目录同步，UI 与 N7 前端尾巴同类）。

## 2. 复用锚点（不造新栈）

| 已有能力 | 位置 | N10 用法 |
| --- | --- | --- |
| 挂起/恢复 | `workflow/executors/human.py` `interrupt()` + `Command(resume=...)` | 审批挂起复用同一语义 |
| HumanTask 仓储/路由/工具 | `persistence/human_tasks/sql.py`、`routers/human_task_routes.py`、`workflow_runtime_tools.py` | 审批任务复用 CRUD / submit / skip / reopen |
| 重执行幂等 | `HumanTaskRepository.find_by_run_and_node` | 审批节点复执行复用同一行（不重复挂起） |
| 非幂等确认门 | `local_app.py::_require_crash_confirm`、`registry._NON_IDEMPOTENT_TYPES` | 审批是 crash_confirm 的**上游**（先审批再确认），不改既有语义 |
| 资产指纹 / 原子写 | `assets/ref.py::fingerprint_file`、`assets/executors` 原子替换 | 预览目标指纹 + 执行前复验（乐观锁） |
| 节点包装层 | `compiler.py` 生命周期事件包装 | 审批门在此统一实现，**执行器零改动** |
| 执行器注册表 | `workflow/registry.py` `ExecutorRegistration` | 加 additive `preview` 字段 + 审批资格标注 |
| 资源错峰 | `apps/session.py`（N8 唯一咽喉） | 补偿动作同样经 manager，不绕过闸门 |
| run 事件 / DLQ | `run_events`、N7 退避/DLQ | 审批拒绝 → 可重试的节点失败 |

## 3. 设计决策

- **D1 审批 = 节点内的两阶段，不是新节点类型**。不可逆节点声明 `params.require_approval=true` 时，`compiler` 的节点包装层在**执行前**：生成 preview → 建 HumanTask（`kind="approval"`）→ `interrupt()` 挂起 → 恢复后按决定继续或终止。理由：一次性解决「批准后执行的还是不是同一件事」（同一函数调用，无跨节点 token 传递）、无需新增端口/节点类型、复用既有中断与幂等契约。
- **D2 预览是纯函数**。`build_preview(node_type, node_id, params, inputs) -> ActionPreview`，唯一 I/O 是读取目标指纹；由 `ExecutorRegistration.preview` 提供，注册表分派。预览可用于：审批任务的 `inputs_snapshot`、`GET /api/workflows/{id}/runs/{run_id}/preview/{node_id}`（只读预览，不挂起）。
- **D3 执行前复验（staleness guard）**。preview 记录每个可指纹目标的 `sha256`/`size`/`mtime`；执行前复验，不匹配 → `WorkflowExecutionError`（信息含 expected/actual），要求重新预览+审批。只在 `require_approval=true` 时强制（默认行为不变）。
- **D4 恢复协议**：`{"decision": true|false, "note": "..."}`；拒绝时按 `params.on_reject`：`fail`（默认，抛 `WorkflowExecutionError`，可被 N7 DLQ/退避消费）/ `skip`（输出端口留空并继续）。`validation_rules` 用既有 `enum` 规则约束 `decision` 为 bool。
- **D5 undo 分两级，默认都不启用**：
  - `params.rollback_on_failure=true` → 节点执行失败时回滚**自己**刚产生的副作用（避免「做了一半失败」留残骸）。
  - run 级撤销：`POST /api/workflows/{id}/runs/{run_id}/undo`（逆序执行已记录补偿）。
- **D6 补偿优先级**：驱动原生 `undo`（`hasattr` 检测，`AppDriver` 协议加**可选**方法，cli 声明 unsupported）→ 文件级备份回滚（宿主端 `os.replace` 原子恢复）→ `none`（不可逆，预览里显式标注 `reversible=false`）。
- **D7 备份区独立于 `assets.roots`**。undo 备份写入 `{DEER_FLOW_HOME}/undo/<run_id>/<node_id>/`（内部保留区），**不受** assets 白名单约束也不暴露为资产——它是引擎私有恢复材料，不是用户资产。
- **D8 持久化**：迁移 `0019_human_task_kind_and_undo`——`human_tasks.kind`（默认 `"task"`，additive）+ 新表 `workflow_undo_records`（`id`/`user_id`/`run_id`/`node_id`/`kind`/`targets`/`backup_paths`/`session_id`/`app_steps`/`status`/时间戳 + `ix_workflow_undo_records_run_id`）。记录 best-effort 写穿透（失败仅日志，不影响节点执行，同 N6 实例记录）。
- **D9 预览能力白名单**：只有非幂等/有副作用节点可被审批——`data:file`(write)、`data:asset`(import/export/convert)、`app:script`、`app:launch`。其余节点声明 `require_approval=true` 是配置错误 → 编译期/运行期明确报错。
- **D10 前端最小集**：不新增节点类型 → 无需改 `types.ts`/`node-catalog.ts`；`params.require_approval`/`on_reject`/`rollback_on_failure` 落在通用 key/value 参数编辑器里。仅补 i18n/文档如需。
- **D11 工具网关不新增 provider**；对话侧新增 builtin 工具 `preview_workflow_action`、`undo_workflow_run`（沿用 `dispatch.py` 的运行单例，不旁路）。

## 4. 步骤

### S1 预览原语
- 新 `workflow/preview.py`：`PreviewTarget`（`path`/`scope`/`sha256`/`size`/`mtime`/`kind`）、`ActionPreview`（`node_id`/`node_type`/`action`/`summary`/`reversible`/`recovery`/`targets`/`risks`）、`build_preview(...)`、`PREVIEWERS` 注册表 + `register_previewer`。
- 预览实现：`data.py::preview_file`（write 模式）、`asset.py::preview_asset`（import/export/convert）、`local_app.py::preview_app_script`/`preview_app_launch`。
- 验收：`tests/test_workflow_preview.py`（纯函数、目标指纹、`reversible`/`recovery` 判定、未知节点 → None）。
- 注册表：`ExecutorRegistration` 加 additive `preview: Callable | None = None`。

### S2 审批门（compiler 包装层）
- 新 `workflow/approval.py`：`ApprovalRequest`/`ApprovalDecision`（纯模型）、`request_approval(runtime, *, node_id, node_type, preview, description) -> ApprovalDecision`（建 HumanTask(kind="approval") + interrupt + 解析恢复 + D4 语义）、`verify_preview_targets(preview) -> list[str]`（D3 复验，返回不一致描述）。
- `compiler.py`：节点包装层在 `params.require_approval=true` 时调 S1 preview → S2 审批 → S3 复验 → 继续执行原执行器；无 preview 的节点类型 → 明确报错（D9）。
- 验收：`tests/test_workflow_approval.py`（批准继续/拒绝 fail/拒绝 skip/复执行复用同一 HumanTask/指纹不匹配报错/未注册 preview 报错/无 repo 时明确降级）。

### S3 HumanTask `kind` 列
- `persistence/human_tasks/model.py` + `sql.py`（`kind` 构造参数、`list_by_user(kind=)` 过滤）、迁移 `0019` 的 `human_tasks.kind` 部分、`human_task_routes.py` 暴露 `kind`、`list_human_tasks` 工具支持 `kind` 过滤。
- 6 处 HEAD 常量测试 `0018`→`0019`（`test_migration_0004_*`、`test_migration_0007_*`、`test_migration_0012_*`、`test_persistence_bootstrap*.py` ×3）。
- 验收：`tests/test_human_task_repository.py` 扩展 + `tests/test_migration_0019_*.py` 新增；既有测试全通过。

### S4 undo 记录模型 + 仓储
- 新 `workflow/undo.py`：`UndoKind`、`UndoRecord`、`plan_undo(records)`（逆序 + 跳过已撤销）、`undo_token`。
- 新 `persistence/workflow_undo/{__init__,model,sql}.py`：`WorkflowUndoRow`（迁移 `0019` 的第二部分）+ `WorkflowUndoRepository`（`create`/`list_by_run`/`get`/`mark_undone`）。
- 验收：`tests/test_workflow_undo_model.py`、`tests/test_workflow_undo_repository.py`。

### S5 文件级备份 / 自动回滚
- `workflow/undo.py`：`backup_host_file(path, *, backup_dir) -> BackupResult`（复制 + 指纹）、`restore_host_file(backup, *, target)`（`os.replace` 原子）。
- `local_app.py`/`asset.py`/`data.py` 的不可逆路径：`params.rollback_on_failure=true` 时执行前备份、失败时回滚（`try/except` + 明确日志），并写 `workflow_undo_records`（best-effort）。
- 无 repo 或备份失败 → **不改执行语义**（备份失败仅日志；`rollback_on_failure=true` 且备份失败时按配置选择「继续执行」还是「拒绝执行」——取保守默认：拒绝执行并报错）。
- 验收：`tests/test_workflow_undo_executors.py`（备份/恢复/失败回滚/备份失败保守拒绝/无 repo 降级）。

### S6 驱动层 undo（原生优先）
- `apps/driver.py`：`AppDriver` 加**可选** `undo`/`snapshot`（Protocol 不强制；调用侧 `hasattr` 检测），`DriverUndoResult(status="undone"|"unsupported", steps, detail)`。
- `drivers/cli.py`：显式 `undo → unsupported`（诚实能力声明）；`drivers/mock.py`：可配置 `undo` 行为供测试/演示。
- `apps/session.py`：`undo(session, *, steps=1)` 经同一咽喉（含 N8 准入），配额与实例归属不变。
- `local_app.py::exec_app_script` with `params.undo_on_failure=true`：优先原生 undo，unsupported → 回落文件级备份（D6）。
- 验收：`tests/test_app_driver_undo.py`、`tests/test_workflow_app_undo.py`。

### S7 API + 对话侧工具
- `routers/workflow_run_routes.py`：`GET /{definition_id}/runs/{run_id}/undo`（候选列表）、`POST /{definition_id}/runs/{run_id}/undo`（执行，逆序，返回逐条结果）；`GET /{definition_id}/runs/{run_id}/preview/{node_id}`（只读预览）。
- `routers/human_task_routes.py`：审批任务 `kind=approval` 的 `preview` 在 `inputs_snapshot` 中返回（additive）。
- builtin 工具：`preview_workflow_action`、`undo_workflow_run`（`workflow_runtime_tools.py` + `dispatch.py`，经运行单例）。
- 验收：`tests/test_workflow_undo_routes.py`、`tests/test_workflow_preview_tools.py`、`tests/test_workflow_undo_tools.py`。

### S8 文档 + 全量回归 + 提交
- 文档同步：根 `AGENTS.md`（workflow 子系统 bullets + `../undo` 层）、`backend/AGENTS.md`（HITL/审批与 undo 小节、Routers 表新增端点、STARTUP_ONLY 无需改、迁移 0019）、`HNFlow 开发规划.md`（N10 行 ◐、P1 第 6 项、M4 行、切片 6 进度注）、`config.example.yaml`（如需新字段→本切片**无新配置段**，仅文档说明）。
- 验证：`ruff check` + `format --check` 全绿；全量离线回归（预期 75 既有平台失败，通过数 +新增）；前端 `pnpm test`/`check`/`format` 全绿。
- 提交：`feat(approval): N10 预览/审批/undo（预览纯函数 + 节点内审批门 + 指纹复验 + 补偿回滚）`，随后跟踪归档小提交。

## 5. 验证策略

- 后端 TDD：每步先写测试（`backend/tests/`），`PYTHONPATH=. .venv\Scripts\python.exe -m pytest <files> -q -p no:cacheprovider`。
- async 执行器测试用 `asyncio.run(...)` 包裹（项目无 async pytest 插件）。
- 迁移测试：`0019` 的 upgrade/downgrade + 幂等重跑；HEAD 常量同步。
- 全量：`pytest -m "not live" tests/ -q --tb=line -p no:cacheprovider`（N9 基线 75 failed / 10160 passed）。
- 端到端手验（可选）：mock 驱动 + 审批 → 拒绝/批准两条路径 + 撤销。

## 6. 开放问题（请裁决）

- **Q1 范围**：本计划 = §21 的「预览/审批/undo」（后两点）。**共享工作区治理**（人在用 presence 探测、抢占 preempt、冲突检测、可见性）建议独立为 **N10b**。是否同意？（同意 → 按本计划执行；不同意 → 我把共享工作区并入，步数增至 ~12）
- **Q2 拒绝语义默认值**：`on_reject` 默认 **`fail`**（拒绝 → 节点失败，可被 N7 退避/DLQ 消费）还是 **`skip`**（拒绝 → 输出留空继续）？我建议 `fail`（不可逆操作被拒绝后继续跑通常会产出错误的下游结果）。
- **Q3 备份失败时的保守策略**：`rollback_on_failure=true` 但备份失败 → **拒绝执行**（保守）还是**照常执行**（可用性优先）？我建议拒绝执行并给出明确错误。
