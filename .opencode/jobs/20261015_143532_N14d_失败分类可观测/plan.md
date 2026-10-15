# N14-切片D 端到端可观测：失败分类（§24.9）— 执行计划

> 来源：《HNFlow 开发方案》§24.9（line 813-830）「trace 贯通 + 成本归因 + 失败分类 + 从 trace 重放」：**失败分类**——稳定 taxonomy（超时/限流/校验/工具/模型/预算），可聚合告警；接口与数据含「失败码常量」。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `5ca9e15`。
> 状态：**已完成（Option A，D1–D7 按建议）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

- **trace 贯通**：已具备——Langfuse/LangSmith 回调在 graph 根部注入，节点→子代理→工具同属一个 trace（`tracing/` + worker/client 在根部 append callbacks）；子代理另有 parent session/user 归组。
- **成本归因**：已具备——`wf:<node>:__token_usage`（W1C）由 worker 折进 `run.end.content["token_usage"]`（含每节点 `nodes` 明细）；Console `/api/console/*` 有 run/thread/agent/token/cost 聚合与 cache-aware 计价。
- **失败分类**：**缺失**。节点失败时：compiler 发 `wf:node:failed`（带 `error`/`error_type`=异常类名）；worker 持久化 `wf:node:failed`（metadata `error_type`）与 `run.error`（metadata `error_type`）。**没有稳定的失败码**，下游只能按 Python 类名聚合——类名不稳定、不可告警。
- 已存在的相关异常类型：`WorkflowExecutionError`（通用执行错误）、`WorkflowCompileError`（配置/定义）、`StructuredOutputError`（§24.4 校验）、`WorkflowConflictError`（N10b 冲突）、`LockError`/`LockTimeoutError`（N8）、N8 `ResourceUnavailableError`；预算耗尽**不抛异常**（以 `stop_reason` 表达，见 §24.5）——故节点级失败分类里「预算」基本不可达，只保留码位。

---

## 二、Option A（推荐）：稳定失败码 taxonomy + 事件/run.error 携带

### A1. 纯逻辑模块 `workflow/failure_taxonomy.py`
- `FAILURE_CODES: frozenset[str]` = `timeout | rate_limit | model | validation | tool | budget | resource | conflict | config | unknown`。
- `classify_failure(exc, *, node_type=None) -> str`——**best-effort 确定性映射**（无 IO、无随机）：
  - `WorkflowCompileError` → `config`
  - `StructuredOutputError` → `validation`
  - `WorkflowConflictError` → `conflict`
  - `LockError`（含超时） → `resource`
  - `asyncio.TimeoutError`/`TimeoutError` → `timeout`
  - 类名/消息含 rate-limit 特征（`ratelimit`/`rate limit`/`429`） → `rate_limit`
  - 类名/消息含 resource-unavailable 特征 → `resource`
  - `WorkflowExecutionError`：`node_type ∈ {tool:bash, tool:http}` → `tool`，否则 → `unknown`
  - 其余 → `unknown`
  - `budget` 码保留（当前节点级不可达；供后续/上下文化使用）。
- **避免循环导入**：对 `compiler`/`registry`/`conflict`/`structured_output`/`locks` 的引用全部**函数内 deferred import**；模块级只依赖 stdlib + `schema.NodeType`。故 compiler 可安全地在模块级 import 它。

### A2. 编译期事件携带失败码
- `compiler._with_node_events` 增加 `node_type` 形参；失败分支在 `wf:node:failed` payload 里加 `error_class=classify_failure(exc, node_type=node_type)`（现有 `error`/`error_type` 不变）。
- `_register` 传入 `node.type`。

### A3. worker 透传/兜底
- 消费 `wf:node:failed` 时把 `data["error_class"]` 写进持久化 metadata（现有 `error_type` 保留）。
- **外层兜底**（异常冒泡出 `astream` 那条路径，line 455）：对冒泡的 `exc` 调 `classify_failure`，写入 `wf:node:failed` 的 content `error_class` 与 metadata，并加入 `run.error` 的 content/metadata 与 `bridge.publish(run_id,"error",...)`。
- 可选：`run.end` 的失败摘要带 `failure_class`（若成本低）。

### A4. 兼容 / 迁移
- 纯新增字段（additive）：旧消费者忽略未知键；事件/元数据形状不破坏。
- **无 schema 迁移、无新表、无新配置段、无新依赖**。

### A5. 前端
- 零改动（事件字段 additive；面板可选后续）。

### A6. 测试（TDD）
- `classify_failure` 纯函数：各异常 → 期望码；`node_type` 对 tool 节点的作用；未知异常 → `unknown`；rate-limit 消息启发式。
- 编译期：构造抛 `WorkflowExecutionError`/`StructuredOutputError` 的节点 → `wf:node:failed` payload 带正确 `error_class`（可断言 `_with_node_events` 包装行为或端到端 worker 事件）。
- worker：run 失败路径的 `wf:node:failed`/`run.error` metadata 带 `error_class`。
- 回归：worker 既有测试、全量离线 A/B 对拍。

### A7. 风险
- 低：纯新增字段 + 一个纯函数；启发式映射是**尽力而为**（明确 `unknown` 兜底，不猜测）。

---

## 三、Option B：§24.3 上下文工程策略（备选）

- AI 节点上下文预算/裁剪/摘要策略声明化。范围更偏执行体（可能触及 subagent），落地不如 A 明确。

> 建议先做 Option A（P0，且复用已落地的 `error_type` 事件位）。

---

## 四、待确认决策

- **D1**：范围 = **Option A（失败分类 taxonomy，推荐）** / Option B（上下文策略）。
- **D2**：码集 = `timeout|rate_limit|model|validation|tool|budget|resource|conflict|config|unknown` —— 确认。
- **D3**：映射为 **best-effort 确定性**（启发式 + `unknown` 兜底，不猜测）—— 确认。
- **D4**：`error_class` 加在 `wf:node:failed`（compiler + worker 兜底）与 `run.error`（additive）—— 确认。
- **D5**：`budget` 码保留但当前节点级不可达（预算以 stop_reason 表达）—— 确认。
- **D6**：trace 贯通 / 成本归因**已具备**，本切片只补失败分类并文档标注 —— 确认。
- **D7**：无迁移/无新表/无新配置/无新依赖；前端零改动 —— 确认。

---

## 五、验收标准
- 节点失败事件与 `run.error` 携带稳定 `error_class`；同类失败可跨 run 聚合统计；旧事件形状兼容。
- 全量离线回归失败集合逐条一致；ruff + 前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`（可观测/失败码）、`HNFlow 开发规划.md` N14/M5 状态。
