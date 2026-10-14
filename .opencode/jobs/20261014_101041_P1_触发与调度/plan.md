# P1 — 触发与调度（切片 3：N7）执行计划

> 依据《HNFlow 开发方案》§18（长期运行与调度）、《HNFlow 开发规划》§五 P1 第 3 项（N7 行）。
> 状态：**已完成（S1–S8）**，提交 `de34214`。

## 1. 目标与范围

N7 = **触发与调度**：在既有 scheduled-task 调度栈上补齐 §18 要求的触发源与可靠性语义：

- **触发源**：`cron` / `once`（已有）→ 新增 **文件监视**、**应用完成事件**、**空闲触发**；手动触发已有。
- **载荷映射**：触发载荷 → **工作流输入端口**（`flow:start` 的 `params`），并支持 agent 目标（保持向后兼容）。
- **可靠性**：触发**幂等/去重**、失败**退避重试**、耗尽后**死信（DLQ）**。

本切片只做 N7，不含 N8（资源治理）、N9–N11。**内核复用既有调度栈，不另起执行栈**（方案 §18 + backend/AGENTS.md 的 scheduled-task 契约）。

## 2. 现状调查（可复用 vs 缺口）

**已有（复用，不重写）**
- 调度服务：`app/scheduler/service.py::ScheduledTaskService`（`run_once` 按 `max_concurrent_runs` 预算领取 → `claim_due_tasks` → `dispatch_task`；lease 领取 + 过期重领；`once` 任务卡死对账 `cancel_stuck_once_tasks`；完成钩子 `handle_run_completion`）。
- 仓储：`persistence/scheduled_tasks/`（`ScheduledTaskRepository`：`claim_due_tasks`/`update_after_launch`/`cancel_stuck_once_tasks`）、`persistence/scheduled_task_runs/`（`ScheduledTaskRunRepository`：`create`/`update_status`/`has_active_runs`/`count_active_runs`/`mark_stale_active_runs`）。
- 原子仲裁：部分唯一索引 `uq_scheduled_task_run_active`（`status IN ('queued','running')`，至多一个活动 run/task）。
- 时间计算：`deerflow/scheduler/schedules.py::next_run_at`（`once`/`cron` + `validate_timezone`/`normalize_cron_expression`）。
- 派发路径：`app/gateway/services.py::launch_scheduled_thread_run`（→ `start_run`，`context={"non_interactive": True}`，`on_disconnect="continue"`，`multitask_strategy="reject"`）；工作流路径 `start_workflow_run`（`workflow_run_routes.create_workflow_run` 是它的 HTTP 先例，含 `_resolve_definition`）。
- 完成钩子键：run metadata `scheduled_task_id` / `scheduled_task_run_id` / `scheduled_trigger`。
- 配置：`config/scheduler_config.py::SchedulerConfig`（`enabled`/`poll_interval_seconds`/`lease_seconds`/`max_concurrent_runs`/`min_once_delay_seconds`）；`scheduler` 已是 **startup-only**（`reload_boundary.STARTUP_ONLY_FIELDS`）。
- 路由：`app/gateway/routers/scheduled_tasks.py`（list/create/get/patch/pause/resume/trigger/delete/runs，`schedule_type` 白名单 `{once, cron}`）。
- 迁移 HEAD = `0017_app_instances`（新迁移将是 `0018_*`）。

**缺口（全新）**
- `schedule_type` 只有 `once`/`cron`：无条件型触发（文件/事件/空闲）。
- 任务只能以 `prompt` 驱动 **lead agent**：无 `target_kind=workflow` + 载荷→端口映射。
- 触发无去重（同一物理触发跨轮询可能重复派发）。
- 失败无退避重试、无死信状态（`failed` 后 `enabled` 任务等下一次时间片，语义上不是「重试」）。

## 3. 设计草案

### 3.1 触发模型（`deerflow/scheduler/triggers.py`，纯函数）
统一「到期」判定，把条件型触发从轮询里解耦出来：

```
is_trigger_due(schedule_type, schedule_spec, *, now, next_run_at, last_run_at, snapshot) -> DueDecision
```
- `once`/`cron`：`next_run_at is not None and next_run_at <= now`（**语义不变**，等价现有 claim 条件）。
- `file`：`{"path"|"root", "glob", "mode": "modified"|"created"}` → 由 `snapshot` 提供扫描结果（匹配文件数、最新 `mtime`），到期 = 存在 `mtime > last_run_at`（`created` 模式另计新增文件）。
- `event`：`{"source": "app", "app": "<name>", "event": "completed"|"failed"|"any"}` → `snapshot` 提供该 app 自 `last_run_at` 以来**转为终态**（`stopped`/`crashed`）的实例行。
- `idle`：`{"idle_seconds": n, "scope": "global"|"app:<name>"}` → 到期 = 自 `last_run_at` 起已连续空闲 ≥ n 秒（`snapshot` 提供「最近活动时间」）。

`snapshot` 由 **app 层 `TriggerProbe`** 填充（harness 不能依赖 app）：`app/scheduler/probe.py` 实现 `build_snapshot(task, *, now, repos)`，读 `app_instances` 表 / 工作区文件 / 活动 run 计数。纯函数 + 探测分离，保证 harness 侧可单测。

`trigger_key`（去重键，纯函数派生）：`file → "<path>:<mtime>"`；`event → "<app>:<session_id>:<status>"`；`idle → "<scope>:<epoch_bucket>"`；`once/cron → None`。

时间型与条件型共用同一轮询循环与 lease：`claim_due_tasks` 的 WHERE 分支扩为「`next_run_at <= now`（时间型）」**或**「`schedule_type IN ('file','event','idle')` 且 `status='enabled'` 且 lease 空闲（条件型，每 poll 评估一次）」。条件型不依赖 `next_run_at`，避免把「条件成立时刻」伪装成时间戳。

### 3.2 目标与载荷映射（`target_kind`）
`ScheduledTaskService` 增**第二个可选注入** `launch_workflow`（app 层实现：解析 definition → `start_workflow_run`，带 `scheduled_task_*` metadata，`on_disconnect="continue"`）。

- 任务新增字段：`target_kind`(`agent`|`workflow`, 默认 `agent`)、`target_definition_id`(可空)、`payload_template`(JSON, 默认 `{}`)。
- 派发时先算 `payload`（本次触发的载荷字典），再用 `payload_template` 渲染：值支持 `{{payload.<key>}}`、`{{now}}`。
  - `agent` 目标：渲染结果经 `{{payload.<key>}}` 插值进 `prompt`（简化：`prompt` 模板优先，模板为空则用原 `prompt`）。
  - `workflow` 目标：渲染结果即 `params`（端口名→值）→ `launch_workflow(definition_id, params, thread_id, metadata)`。缺 `launch_workflow` 注入时 `workflow` 目标以明确错误失败（不静默降级）。
- 兼容：现有任务 `target_kind` 默认 `agent`，行为与今天**逐字节一致**。

### 3.3 幂等 / 去重
- `scheduled_task_runs` 增 `dedupe_key`(String(128), 可空)，迁移建**部分唯一索引** `uq_scheduled_task_run_dedupe(task_id, dedupe_key) WHERE dedupe_key IS NOT NULL`（SQLite/Postgres；`NULL` 不参与，`once`/`cron` 不受影响）。
- `create` 捕获该索引冲突 → 复用现有 `ActiveScheduledRunConflict` 语义路径（新增 `DuplicateTriggerConflict` 或复用），映射为 **`skipped` 计数**（`error="duplicate trigger"`），不派发。DB 是原子仲裁者（与 `uq_scheduled_task_run_active` 同模式）。
- 条件型触发的 probe 快照可能跨轮询重复（同一 mtime/同一终态行），唯一索引即兜底。

### 3.4 退避重试 + 死信（DLQ）
- 任务新增：`max_attempts`(int, 默认 **1** = 不重试，范围 1–10)、`attempt`(int, 默认 0)。
- `handle_run_completion` 收到**真实 run 失败**（`error`/`timeout`）时：
  - `attempt + 1 < max_attempts` → 重新武装：`attempt += 1`、`next_run_at = now + min(base * 2**attempt, cap)`、`status='enabled'`、保留 `last_error`；条件型任务 `next_run_at` 置 `now`（下轮 poll 再评估条件）。
  - 否则 → `status='dead_lettered'`（新终态，**不在** `claim_due_tasks` 可领取集合内）。
- `scheduled_task_runs` 增 `attempt`(int, 默认 0) 记录第几次尝试（便于观测）。
- DLQ 排空：`POST /api/scheduled-tasks/{id}/requeue` → 重置 `attempt=0`、`status='enabled'`、`next_run_at=now+min_once_delay_seconds`（条件型置 `now`）。
- 配置新增：`scheduler.retry_backoff_seconds`(默认 60, ge=1)、`scheduler.max_retry_backoff_seconds`(默认 3600, ge=1)。`max_attempts` 为**每任务**字段（默认 1 → 现有行为零变化）。

### 3.5 路由（`routers/scheduled_tasks.py`）
- create/update：`schedule_type` 白名单 → `{once, cron, file, event, idle}`；按类型做 `schedule_spec` 结构校验（条件型必须给 `next_run_at=None`，且不走 `min_once_delay_seconds` 校验）；新增 `target_kind`/`target_definition_id`/`payload_template`/`max_attempts` 字段（workflow 目标校验 definition 存在，复用 `get_workflow_definition_repo`）。
- 新增 `POST /{id}/requeue`（DLQ 排空）。
- `GET /{id}/runs` 返回带 `dedupe_key`/`attempt`（自动，dict 透传）。
- memory 后端 / 无调度服务时的现有 503 语义不变。

### 3.6 配置与迁移
- 迁移 `0018_scheduled_task_triggers.py`：给 `scheduled_tasks` 加 `target_kind`/`target_definition_id`/`payload_template`/`max_attempts`/`attempt`；给 `scheduled_task_runs` 加 `dedupe_key`/`attempt` + 部分唯一索引 `uq_scheduled_task_run_dedupe`。ORM `__table_args__` 同步（空库 `create_all` 路径不吃迁移）。
- `config.example.yaml`：`scheduler` 段加两个新字段；`config_version` 35 → 36。

### 3.7 前端
本切片**不改前端**（与 N6 同策略）：现有 UI 只创建 `once`/`cron`，新触发类型与工作流目标经 API/agent 使用；UI 另开切片。

## 4. 决策（待确认，均推荐）
1. **范围**：只做 N7（触发源 + 载荷映射 + 幂等/退避/DLQ）；不做通知/资源治理。—— 推荐
2. **触发实现**：**复用现有 scheduled-task 栈**，新增 `schedule_type=file|event|idle` + 纯函数 `is_trigger_due` + app 层 `TriggerProbe`（不在 harness 引入事件总线 / 不新增后台线程）。—— 推荐（备选：独立事件总线，重、与「不另起执行栈」冲突）
3. **应用事件来源**：**轮询 `app_instances` 表**（N6 已写穿透，DB 为准），不引入内存事件通道（重启不丢）。—— 推荐
4. **载荷映射**：`payload_template` + `{{payload.<key>}}`/`{{now}}` 字符串插值 → agent `prompt` 或 workflow `params`；**不做**复杂表达式/条件映射。—— 推荐
5. **去重**：`(task_id, dedupe_key)` 部分唯一索引为原子仲裁，冲突记为 `skipped`；`once`/`cron` 的 `dedupe_key=NULL` 不受影响。—— 推荐
6. **重试**：`max_attempts` 每任务默认 **1**（opt-in 才重试）；指数退避 + 上限；耗尽 → `dead_lettered` + `POST /requeue` 排空。不改现有 `once`/`cron` 默认行为。—— 推荐
7. **前端**：本切片不动（后端 + API only）。—— 推荐
8. **通知**：`tool:notify` 的长时任务通知**不在本切片**（属 §18 末段，与 N7 触发语义解耦），记为后续增量。—— 推荐

## 5. 验收标准
- 新增 `schedule_type=file`：写入匹配文件后下一 poll 派发一次；同一 mtime 不再重复派发（去重键命中 → `skipped`）。
- 新增 `schedule_type=event`：`app_instances` 某行转 `crashed`/`stopped` 后派发一次；重复行不重复派发。
- 新增 `schedule_type=idle`：系统空闲 ≥ n 秒派发；期间有活动 run 则不派发。
- `target_kind=workflow`：任务派发 `start_workflow_run`，`params` 由 `payload_template` 渲染（含 `{{payload.x}}`/`{{now}}`），run metadata 带 `scheduled_task_id`，完成钩子正确回写。
- `max_attempts=3`：连续失败按指数退避重试，第 3 次失败后 `dead_lettered`；`/requeue` 后重新可领取。
- 现有 `once`/`cron` 行为不变（默认 `target_kind=agent`、`max_attempts=1`、`dedupe_key=NULL`）。
- 后端 pytest 全绿（仅既有平台失败）；ruff 干净；`config_version` 校验随例更新。

## 6. 测试策略（TDD，强制）
- `tests/test_scheduler_triggers.py`（新）：`is_trigger_due` 四类 + `trigger_key` + 边界（无匹配/时间倒挂/`last_run_at=None`）。
- `tests/test_scheduler_probe.py`（新）：`TriggerProbe` 快照（file 扫描、app_instances 终态行、idle 最近活动）。
- `tests/test_payload_template.py`（新）：插值/缺键/转义/`{{now}}`。
- `tests/test_scheduled_task_service.py`（扩展）：条件型 dispatch、`launch_workflow` 分支、重试退避、`dead_lettered`、去重冲突 → `skipped`。
- `tests/test_scheduled_task_repository.py` / `test_scheduled_task_claims.py`（扩展）：条件型领取、`dead_lettered` 不可领取、`attempt` 字段。
- `tests/test_scheduled_task_runs_repository.py`（若存在则扩展）：`dedupe_key` 部分唯一索引冲突 → `DuplicateTriggerConflict`。
- `tests/test_scheduled_tasks_router.py`（扩展）：新类型校验、`requeue`、workflow 目标校验。
- 迁移冒烟：`0018` 升级后新列/索引存在。
- `tests/test_reload_boundary.py`（`scheduler` 仍 startup-only）+ `config_version` 测试随例更新。

## 7. 风险
- **claim 查询语义扩张**：条件型任务每次 poll 都进入候选集，必须确保 lease/`max_concurrent_runs` 预算与时间型一致，避免条件型饿死时间型（按 `next_run_at ASC NULLS LAST` + id 排序 + 预算共享；补测试）。
- **条件型 `next_run_at` 语义**：置 `None` 会与「一次性任务已消费」混淆；`claim_due_tasks` 现有 `next_run_at IS NOT NULL` 前置条件需按类型分支，避免误领 `once` 已消费任务。
- **去重索引与 `active` 索引叠加**：两个部分唯一索引可能同时冲突，`create` 的 IntegrityError 翻译需按 `status`/`dedupe_key` 判定，避免误报 `ActiveScheduledRunConflict`。
- **编排边界**：本切片不引入资源配额/通知/前端，避免越界 N8/N10。

## 8. 执行顺序（确认后）
1. `deerflow/scheduler/triggers.py`（`is_trigger_due` + `trigger_key` + spec 解析）+ 单测。
2. 迁移 `0018_scheduled_task_triggers` + ORM 字段/索引 + 仓储方法（`attempt`、`dedupe_key` 冲突翻译、条件型 `claim_due_tasks` 分支）+ 仓储测试。
3. `SchedulerConfig` 两个新字段 + `config.example.yaml` + `config_version` 36 + reload 边界测试。
4. `app/scheduler/probe.py::TriggerProbe`（`app_instances`/文件/活动 run 快照）+ 单测。
5. `payload_template` 渲染器（harness 纯函数）+ 单测。
6. `ScheduledTaskService`：条件型 dispatch、`launch_workflow` 分支、去重冲突 → `skipped`、退避重试、`dead_lettered` + 服务测试。
7. `app/gateway/services.py::launch_scheduled_workflow_run` + `app.py` 注入 + `routers/scheduled_tasks.py`（新类型校验、字段、`requeue`）+ 路由测试。
8. 文档同步（根/backend `AGENTS.md`、规划进度、`config.example.yaml` 注释）+ 全量离线回归 + ruff + 提交。
