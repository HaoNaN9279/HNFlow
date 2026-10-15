# N14-切片F 工作流事务与自愈（§24.7）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.7（line 766-786）：本地专业软件副作用大多**不可逆**，需 effect journal + 幂等键端到端 + 补偿动作 + 有界自愈。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`；分支 `deerflow-rebase`；起点 `53be8a8`。
> 状态：**进行中**。

---

## 一、现状（已核对代码）

- **补偿 / undo（已完成，N10）**：`workflow/compensation.py`（`params.rollback_on_failure` 先备份后执行、失败即回滚）+ `workflow/undo.py`/`undo_service.py`（`workflow_undo_records` 表 = effect journal + 逆序补偿）。→ §24.7 的「补偿（saga）」与「effect journal（变更类）」已有载体。
- **应用原生 undo（已完成，N10）**：`supports_undo` + `undo` 双条件。
- **缺失**：① 幂等键端到端（节点执行 ID → 外部调用透传：MCP/HTTP 幂等头）；② 有界自愈——失败后对**幂等**节点自动重试（非幂等转人工）。

## 二、Option A（采纳）：幂等键端到端 + 有界节点重试

### A1. 新建纯模块 `workflow/reliability.py`

- `RetryPolicy`：`max_attempts`（1..10，默认 3）+ `backoff_seconds`（0..60，默认 0）+ `retry_on`（可选 `FailureCode` 列表）。
- `parse_retry_policy(params) -> RetryPolicy | None`：读 `params.retry`；坏形状抛 `RetryPolicyError`（编译期可见）。
- `is_retryable_exception(exc)`：**控制流信号永不重试**（`GraphInterrupt`/`GraphBubbleUp`/`asyncio.CancelledError`）+ `BaseException` 非 `Exception` 永不重试。
- `should_retry(policy, *, attempt, exc) -> bool`：`attempt` = 已执行次数（1-based）；`attempt < max_attempts` 且异常可重试且（`retry_on` 缺省或含 `classify_failure(exc)`）。
- `idempotency_key(run_id, node_id) -> str`：**稳定键**（不含 attempt——重试必须复用同一键才能被外部去重），`f"{run_id}:{node_id}"`。
- `resolve_idempotency_key(params, *, run_id, node_id)`：`params.idempotency` 为字符串则原样用，`True` 则派生稳定键。
- 常量：`RETRY_RESULT_KEY = "__retry"`、`IDEMPOTENCY_ENV = "DEERFLOW_IDEMPOTENCY_KEY"`、`IDEMPOTENCY_HEADER = "Idempotency-Key"`。

### A2. 编译期：幂等性 + 重试校验（`compiler.py`）

- `CompileContext` 增 `idempotent_by_type: dict[NodeType, bool]`（由 `ExecutorRegistry.build_context` 填充；进缓存指纹）。
- `_validate_retry(def_, ctx)`：`params.retry` 只能落在**幂等**的 executor 节点上；非幂等（bash/http/app:launch/app:script）声明 `params.retry` → `WorkflowCompileError`（诚实：非幂等自动重试 = 重复副作用）。
- `params.idempotency` 校验：`bool` 或非空 `str`，余者报错。
- `_build_state_schema`：声明 `wf:<node>:__retry` 保留通道（仅声明 retry 的节点）。

### A3. 运行期：有界重试（`_make_node_fn`）

- 新参数 `idempotent: bool`；重试**只包裹 `_resolve_executor` 调用**（在审批门之后），异常/取消/控制流不吞。
- 退避 `asyncio.sleep(backoff_seconds)`；用尽后重抛最后一个异常（节点失败）。
- 重试次数写入 outputs 的 `wf:<node>:__retry`（`attempt-1` 次重试；0 不写）。
- `params.idempotency` 真值时把 `__idempotency_key` 注入 `executor_params`（不污染原参数）。

### A4. 执行器：幂等键透传（`executors/tool.py`)

- `tool:http`：`__idempotency_key` 存在则加 `Idempotency-Key` 请求头（调用方已显式给同名头则尊重）。
- `tool:bash`：`__idempotency_key` 存在则注入 `DEERFLOW_IDEMPOTENCY_KEY` 环境变量（env 合并，不覆盖调用方同名值）。

### A5. 边界 / 取舍（诚实标注）

- 节点级重试**仅幂等节点**；非幂等失败仍走人工确认（与 §12.4 一致）。
- 「AI 诊断式自愈」为后续增量（本切片落地机械有界重试）。
- **无迁移 / 无新表 / 无新配置段 / 无新依赖**；前端零改动（`params` 级）。

### A6. 测试（TDD）

- `tests/test_workflow_reliability.py`：纯函数（解析/形状/重试判定/控制流不重试/幂等键稳定）+ 编译期（非幂等声明 retry 报错 / 非法 idempotency）+ 运行期（幂等节点重试成功、退避、用尽抛错、`__retry` 通道、不重试控制流）+ 执行器（http 头 / bash env 注入）。
- 回归：全量离线 A/B 对拍（基线 75 failed / 10867 passed / 104 skipped，失败集须逐条一致 — 平台族）。
- ruff check/format 干净。

### A7. 文档

- `AGENTS.md`：`workflow/` 增 `reliability.py` bullet，`compiler.py` / `executors/tool.py` bullet 补幂等键/重试。
- `HNFlow 开发规划.md`：N14 行 + M5 行 + 切片 F 进度注。

---

## 三、验收标准

- 幂等节点可声明有界重试并安全成功/用尽失败；非幂等节点声明重试为编译期错误；控制流信号永不重试。
- 外部调用可携带稳定幂等键（HTTP 头 / 脚本环境变量）。
- 全量离线回归失败集无新增；ruff 干净。
