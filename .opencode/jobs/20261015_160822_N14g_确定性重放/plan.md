# N14-切片G 确定性重放（§24.11）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.11（line 856-873）：AI 非确定，须区分可重放/不可重放；录制模型/工具输出，支持确定性回放、测试与追溯。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`；分支 `deerflow-rebase`；起点 `53be8a8`（N14f 改动在其上，未提交）。
> 状态：**进行中**。

---

## 一、现状

- `data`/`flow` 节点天然确定；`tool`/`ai`/`app` 节点调用外部（HTTP/命令/模型/软件），非确定。
- 既有：编译缓存（definition 哈希）、`run_events`（JSONL/DB 事件流）、N10 `workflow_undo_records`（副作用日志）。
- 缺失：**run 级录制夹具**（把非确定调用结果落到 fixture）+ **回放模式**（跳过真实调用、确定性重跑）。

## 二、Option A（采纳）：节点级 record/replay

节点是执行引擎唯一的「副作用边界」，也是 AI/工具结果的汇聚点——在 compiler 节点包装层录制/回放 `(inputs → outputs)` 粒度即可获得**整图确定性回放**，无需侵入模型层。

### A1. 新建 `workflow/replay.py`

- `ReplayEntry`（`node_id`/`node_type`/`inputs_digest`/`outputs`）+ `ReplayFixture`（`run_id`/`entries`/`schema_version`）。
- `input_digest(node_id, node_type, inputs)`：规范化 JSON（sort_keys, default=str）→ sha256，**确定性**。
- `ReplaySession(mode, fixture, on_miss, redact)`：`mode ∈ {record, replay}`；`record(...)` 追加条目（可选脱敏）；`replay(...)` 命中返回输出，未命中按 `on_miss`（`error` 默认 = `ReplayMissError`；`live` = 返回 None 走真实执行）。
- `redact_secrets(value)`：递归把密钥名（`*key*/*token*/*secret*/*password*/*credential*` + 显式名单）的值替换为 `***`，**纯函数**。
- `save_fixture`/`load_fixture`：JSON 持久化（临时文件 + `os.replace` 原子写）。
- 常量 `REPLAY_CONTEXT_KEY = "__replay_session"`。

### A2. compiler 集成（`_make_node_fn`）

- 读 `runtime_context[REPLAY_CONTEXT_KEY]`；`replay` 模式命中即用录制输出**跳过 executor**（退避/重试不触发）；未命中 miss 策略生效。
- `record` 模式：executor（含重试）成功后 `session.record(...)`。
- 未提供 session → 零行为变化（仅一次 dict 查找）。
- **节点级 `__replayed` 保留通道**？——不加（保持最小；fixture 本身即证据）。

### A3. 边界 / 取舍（诚实标注）

- 录制粒度 = **节点输出**（含 AI 节点整体结果），不录制模型内部逐 token；这是「图确定性」而非「模型确定性」。
- 确定性节点（data/flow）也被录制——回放时一并跳过，得到**更强**的整图确定性；如只需非确定节点，后续可按 idempotent 过滤。
- 与 lockfile 关联、worker/config 自动录制开关、检索/记忆快照录制为后续增量。
- **无迁移 / 无新表 / 无新配置段 / 无新依赖**；前端零改动。

### A4. 测试（TDD）

- `tests/test_workflow_replay.py`：digest 稳定性/敏感性、脱敏、fixture 往返（JSON/文件）、session record/replay/miss(error/live)、编译执行（record 模式产出 fixture；replay 模式命中跳过 executor 且不改调用计数；miss → ReplayMissError；on_miss=live 回退真实执行）。
- 全量 A/B 对拍；ruff。

### A5. 文档

- `AGENTS.md`：`workflow/` 增 `replay.py` bullet。
- `HNFlow 开发规划.md`：N14 行 + M5 行 + 切片 G 进度注。
