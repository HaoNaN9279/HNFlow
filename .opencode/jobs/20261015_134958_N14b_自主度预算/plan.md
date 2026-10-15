# N14-切片B 自主度预算（§24.5）— 执行计划

> 来源：《HNFlow 开发方案》§24.5（line 698-718）「显式定义自主度档位 + 硬预算 + 可观测」：`template`（确定性模板，现状默认）/ `bounded`（受限工具循环 max_turns/token/tool_calls，每项硬上限）/ `delegated`；`Node.params.autonomy: {mode, budgets}`；`ai.py` 按档位配置执行体；超限即停并产出部分结果（复用 token/turn/loop 三轴 `stop_reason`）。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `af433de`。
> 状态：**已完成（Option A，D1–D8 按建议）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

- `ai:llm_agent`（`executors/ai.py`）经 `SubagentExecutor` 执行；`SubagentConfig` 目前只有 `max_turns`（默认 50）、`timeout_seconds`、`allow_recursion`（本节点固定 `False`）。
- **`max_turns` 已直连**：`SubagentExecutor._aexecute` 设 `recursion_limit = self.config.max_turns`（executor.py:869）。超出 → `GraphRecursionError` → 已恢复部分结果并标 `stop_reason=turn_capped`。
- **`token` 预算走中间件**：`build_subagent_runtime_middlewares`（tool_error_handling_middleware.py:371）按 `app_config.subagents.get_token_budget_for(agent_name, ...)` 取 `TokenBudgetConfig`（`config.yaml` `subagents.agents.<name>.token_budget` 可按 name 覆盖）；硬停 = 剥离 tool_calls、强制收尾，**不 raise**，`stop_reason=token_capped`。**无 per-node 通道**。
- **`tool_calls` 预算无任何机制**（`LoopDetectionMiddleware` 是「重复调用」检测，非计数上限）。
- `SubagentResult` 已带 `stop_reason`（`token_capped`/`turn_capped`/`loop_capped`）与 `token_usage_records`——现成可观测。
- AI 节点已有 reserved 通道先例：`__workflow_token_usage` → `wf:<node_id>:__token_usage`（`_build_state_schema` + `_make_node_fn` 提升）。

**关键认知**：当前 `template` 模式下 AI 节点**已带工具**（capability_groups 装配），因而本就可能循环（受全局 `subagents.token_budget` 与默认 `max_turns` 约束）。**§24.5 的增量 = 让作者对单个 AI 节点显式声明档位与硬预算 + 可观测 stop_reason**，而非从「无循环」变成「有循环」。为满足「`template` 保持默认零破坏」，**不改变 template 行为**。

---

## 二、Option A（推荐）：`ai:llm_agent` 的 `params.autonomy`

### A1. 参数
```jsonc
"autonomy": {
  "mode": "template" | "bounded",     // 默认 template = 现状，零变化
  "budgets": {                         // 仅 bounded 生效
    "max_turns": <int>,                // 硬上限 → recursion_limit
    "max_tokens": <int>                // 硬上限 → TokenBudgetConfig.max_tokens
  }
}
```
- `mode=bounded`：
  - `SubagentConfig.max_turns = budgets.max_turns`（缺省沿用 50）；
  - `SubagentConfig.token_budget = TokenBudgetConfig(enabled=True, max_tokens=budgets.max_tokens)`（仅当提供 `max_tokens`）；
  - `allow_recursion` **保持 False**（bounded = 受限**工具**循环，非委派；委派是 `delegated`，列后续）；
  - 其余（tools/identity/capability/continue）不变。
- **`max_tool_calls` 不在本切片**：无现成机制（需新预算中间件 + `stop_reason` 契约新增值 `tool_calls_capped`，跨 workflow/subagents/前端契约）；提供该字段 → **编译期明确报错「未支持」**（fail-loud，不静默忽略）。

### A2. 可观测（stop_reason）
- `exec_llm_agent` 把 `result.stop_reason` 放进 **reserved 结果键** `__stop_reason`；`_make_node_fn` 提升到 `wf:<node_id>:__stop_reason` 通道（同 `__token_usage` 先例）。
- `worker` run.end / `get_workflow_run` 可将该通道并入 additive 观测（若成本低；否则仅通道可见）。

### A3. subagent 管道（最小新增）
- `SubagentConfig` 增字段 `token_budget: TokenBudgetConfig | None = None`。
- `build_subagent_runtime_middlewares` 增参数 `token_budget_override: TokenBudgetConfig | None = None`：非空则**优先**于 `app_config` 的 per-agent/global 查询。
- `SubagentExecutor._create_agent` 传 `self.config.token_budget` 作为 override（None = 现状）。
- **向后兼容**：override 为 None 时行为字节不变。

### A4. 兼容 / 迁移
- 纯新增参数与可选字段；未声明 `autonomy` 的节点行为不变。
- **无 schema 迁移、无新表、无新配置段、无新依赖**。

### A5. 前端
- 无目录变更（`autonomy` 是节点参数，画布表单当前不渲染 AI 节点这些字段；与 `iterations`/`continue_on`/`resource_lock` 一致）。可选 i18n 后续。

### A6. 测试（TDD）
- `template` 默认：`SubagentConfig` 字段与现状一致（零变化）。
- `bounded`：`max_turns` 落到 `recursion_limit`；`max_tokens` 生成的 `TokenBudgetConfig` 经 override 进 `build_subagent_runtime_middlewares`（可 monkeypatch 断言）。
- `stop_reason` 提升到 `wf:<node>:__stop_reason`。
- 编译期校验：`mode` 非法 / `max_tool_calls` 提供 / 预算非正 → 报错。
- 回归：AI 节点既有测试、全量离线 A/B 对拍。

### A7. 风险
- 低—中：`token_budget_override` 是 additive 参数；`max_turns` 已是被读字段。
- 边界：`delegated` 档（放开委派）与 `max_tool_calls` 列后续。

---

## 三、Option B：§24.6a 有界评审回环（producer↔critic）

- 迭代上限 + 「评审结论注入下一轮上下文」+ 评审身份。
- **观察**：多数已可用现成原语表达（`flow:loop` 正宗版 `results`/`last` 承载多轮、回边把 critic 结论喂回下一轮；`data:shared` 黑板承载评审清单），增量主要是**一等模式/预算**。相对 A，**新能力增量较小**。

> 建议：**先做 Option A（自主度预算，真实能力缺口）**；有界评审回环随后（可基于 A 的预算）。

---

## 四、待确认决策

- **D1**：范围 = **Option A（§24.5 自主度预算，推荐）** / Option B（评审回环） / 两者。
- **D2**：档位 `template`（默认，零变化）/ `bounded`（显式硬预算）；**`delegated` 列后续** —— 确认。
- **D3**：`bounded` 预算 = `max_turns` + `max_tokens`（`max_tool_calls` 本切片**不支持**，提供即编译期报错）—— 确认。
- **D4**：`bounded` 保持 `allow_recursion=False`（工具循环，不放开委派）—— 确认。
- **D5**：`stop_reason` 经 reserved 通道 `wf:<node>:__stop_reason` 暴露（同 `__token_usage` 先例）—— 确认。
- **D6**：subagent 管道最小新增：`SubagentConfig.token_budget` + `build_subagent_runtime_middlewares(token_budget_override=...)` + executor 透传（None=现状）—— 确认。
- **D7**：无迁移/无新表/无新配置/无新依赖；前端零改动 —— 确认。
- **D8**：`max_tool_calls` 与 `delegated` 档列后续（含 `stop_reason` 契约新增值）—— 确认。

---

## 五、验收标准
- `template` 节点行为字节不变；`bounded` 节点 `max_turns`/`max_tokens` 硬上限生效、超限产部分结果并带 `stop_reason`；`__stop_reason` 通道可见。
- 未声明 `autonomy` 的定义不变；全量离线回归失败集合逐条一致；ruff + 前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`（AI 节点/预算）、`HNFlow 开发规划.md` N14/M5 状态。
