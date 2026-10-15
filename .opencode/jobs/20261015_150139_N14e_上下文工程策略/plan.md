# N14-切片E 上下文工程策略（§24.3）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.3（line 651-669）：三层提示词解决静态组装，但**运行期装入窗口的内容**（检索片段、工具结果、历史压缩、few-shot、system reminder）无**节点级**策略，成本与质量不可控。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`；分支 `deerflow-rebase`；起点 `e4d0fb4`。
> 状态：**已完成（Option A，D1–D7 按建议）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

- **三层提示词**（`workflow/prompts.py`）：identity → capability → task 纯函数组装，`ai.py::exec_llm_agent` 再追加 `schema_instruction`（§24.4）。**组装顺序固定但不可声明式控制装入内容**。
- **工具结果预算**：`ToolOutputBudgetMiddleware`（全局 `tool_output` 配置）——超限外置到磁盘 + 摘要引用。**非节点级**。
- **历史压缩**：`DeerFlowSummarizationMiddleware`（全局 `summarization` 配置）挂在 subagent runtime（`build_subagent_runtime_middlewares`）。**非节点级**。
- **检索/记忆**：`MemoryMiddleware` + `DynamicContextMiddleware` 仅挂在 **lead agent**，AI 节点不享有；AI 节点的"检索结果"只能经**输入端口**流入（这是本切片可用的挂载通道）。
- **token 计量**：`_count_tokens` 只存在于 vendored deermem 内部；harness 层**无**通用 token 工具（`memory.token_counting: char` 用 CJK-aware 字符估算，是既有先例）。
- **节点级可观测既有**：`wf:<node>:__token_usage`（W1C）、`__stop_reason`、`__schema_repairs` 等保留通道。

**结论**：§24.3 的"工具结果外置 / 历史压缩"部分**已被全局中间件覆盖**；真正缺失的是**节点级声明式控制"装什么（few-shot/检索片段）、装多少（预算）、顺序（确定性）、用量可见"**。

---

## 二、Option A（推荐）：节点级 `context_policy` 声明式上下文

### A1. 新建纯模块 `workflow/context_policy.py`（无 I/O、无重依赖）

- `estimate_tokens(text: str) -> int`：**CJK-aware 字符估算**（确定性、离线、无 tiktoken），与 `memory.token_counting: char` 同一哲学，文档标注为**估算**而非精确。
- `DEFAULT_BUCKET_ORDER = ("identity","capability","task","examples","context","schema")`：**固定拼接顺序**（保证 prompt 前缀稳定 = 服务缓存友好）。
- `parse_context_policy(params) -> ContextPolicy | None`：读取 `params.context_policy`，坏形状抛 `ContextPolicyError`（编译期可见）。
- `apply_context_budget(buckets: dict[str,str], budget: int|None) -> ContextBudgetResult`：**纯函数**，按固定顺序拼接；预算只作用于**可截断桶** `examples`/`context`，逐条丢弃并记录 `dropped`；`identity/capability/task/schema` 为**不可截断骨架**（instruction 本身超预算不静默截断，改记 `over_budget: true`）。
- `ContextPolicy` 字段：
  - `examples: list[str] | None`——声明式 few-shot（字符串或 `{input, output}` 映射转文本）；渲染为 `<examples>` 块。
  - `include: list[str] | None`——**按名挂载输入端口值**（检索结果/上游产物），渲染为 `<context>` 块；每段带 `--- <port> ---` 分隔。
  - `budget: {total_tokens: int} | None`——`examples`+`context` 两桶合计上限。
- `CONTEXT_USAGE_RESULT_KEY = "__context_usage"`（保留结果键）。

### A2. 组装器改造（`workflow/prompts.py`，纯函数）

- 新增 `build_examples_layer(examples)` 与 `build_context_layer(include, inputs)`（后者复用 `{{port}}` 同源取值语义，但按 `include` 顺序、键缺失=跳过）。
- `assemble_ai_node_prompt` 顺序扩展为 A1 的固定顺序；`ai.py` 直接调用的 sections 列表同步。

### A3. 执行器接入（`workflow/executors/ai.py`）

- template 模式：读 `params.context_policy`，组装 buckets → `apply_context_budget` → `system_prompt`；把 `__context_usage` 放进 `output`（additive）。
- **continue 模式**：`context_policy.examples/include` 不适用（会话首轮已固化）→ 与 `output_schema` 同级处理：**运行期明确报错**（不静默忽略）。
- 与 `output_schema` 共存：`schema` 桶置于最后。

### A4. 编译期校验（`compiler.py::_validate_context_policy`）

- `examples` 元素类型、`include` 名单必须 ⊆ 该节点**已声明的输入端口集**、`budget.total_tokens` 为正整数 → 违反即 `WorkflowCompileError`（与 §24.4/§24.5 同款编译期门）。

### A5. 可观测

- 保留通道 `wf:<node>:__context_usage`：`{estimated_tokens: {bucket: int}, dropped: [...], over_budget: bool, budget: int|null}`——由 compiler 声明并写 state（与 `__schema_repairs`/`__stop_reason` 同机制），节点级用量明细可见。

### A6. 边界 / 取舍（诚实标注）

- **不引 tiktoken**：估算而非精确计数；避免网络下载与重依赖（与既有 char 估算一致）。
- **工具结果外置 / 历史压缩**：沿用现有**全局**中间件，本切片**不做**节点级 override（需要把配置下沉到 subagent runtime middlewares，另立切片）。
- **无迁移 / 无新表 / 无新配置段 / 无新依赖**；前端 `context_policy` 为可选 params，**零改动**。

### A7. 测试（TDD）

- `context_policy.py` 纯函数：`estimate_tokens`（ASCII/CJK/混合）、`parse_context_policy`（合法/坏形状）、`apply_context_budget`（无预算全保留；预算充足；预算迫使按序丢弃 examples→context；骨架超预算 → `over_budget` 且不截断）。
- 组装器：`examples`/`context` 层渲染顺序与格式；`include` 缺键跳过。
- `ai.py`：template + policy → `system_prompt` 含 `<examples>`/`<context>` 且 `__context_usage` 正确；continue + policy → 报错。
- `compiler`：`include` 未声明端口 → 编译期报错；`budget` 非正 → 编译期报错。
- 回归：既有 `test_workflow_ai_node.py` 等；全量离线 A/B 对拍（基线 77/10812/104，失败集须逐条一致）。

### A8. 文档

- `AGENTS.md`：`workflow/` 增 `context_policy.py` bullet，`prompts.py`/`ai.py` bullet 补 `context_policy`。
- `HNFlow 开发规划.md`：N14 行 + M5 行 + 逐切片进度注。

---

## 三、Option B（备选）

§24.11 确定性重放（record/replay fixtures + 脱敏 + 回放执行）——P0 但体量大（触及模型/工具调用录制、fixture 存储、record/replay 开关），不宜与 §24.3 同刀。

> 建议执行 **Option A**（§24.3），§24.11 单独成刀。

---

## 四、待确认决议

- **D1**：范围 = **Option A 节点级 `context_policy`（推荐）** / Option B 确定性重放。
- **D2**：桶与顺序 = `identity→capability→task→examples→context→schema`（固定）；预算仅约束可截断桶 `examples`/`context`（推荐）。
- **D3**：预算度量 = **无依赖 CJK-aware 字符估算**（确定性/离线/标注为估算），不引 tiktoken（推荐）。
- **D4**：截断策略 = 固定优先级 `context` 先、`examples` 后，逐条丢弃并记录 `dropped`；骨架超预算 → 记 `over_budget` **不截断**（推荐）。
- **D5**：观测 = 保留通道 `wf:<node>:__context_usage`（additive）（推荐）。
- **D6**：工具结果外置 / 历史压缩**沿用全局中间件**，节点级 override **延后**（推荐）。
- **D7**：无迁移 / 无新表 / 无新配置段 / 无新依赖；前端零改动（推荐）。

---

## 五、验收标准

- 节点可声明 few-shot 与检索挂载；超预算内容被**确定性截断/丢弃**，拼接顺序**固定**；用量明细可见（`__context_usage`）。
- 全量离线回归失败集无新增；ruff check/format 干净；前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`、`HNFlow 开发规划.md`。
