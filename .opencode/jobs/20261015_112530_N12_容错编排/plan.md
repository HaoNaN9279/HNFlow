# N12 容错编排（Try-Catch / Finally）— 执行计划

> 来源：《HNFlow 开发方案》§24 编排增强（line 993）「容错编排：Try-Catch / Finally 节点，子图异常捕获走 catch 分支；失败降级与失败回调。当前流程控制仅 if/switch/loop/parallel/wait」；《HNFlow 开发规划.md》N12 行（line 101、159）。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `8fe3747`。
> 状态：**已完成（Option A，D1–D8 按建议）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

**错误传播**：`compiler._with_node_events`（line 321）在节点抛异常时发 `wf:node:failed` 事件后**原样 `raise`**；异常一路冒泡出 LangGraph，`worker.py`（line 438 附近）捕获 → 把 run 置为终态 error。**图内没有任何节点级错误捕获**。

**已有的「子图」机制**（N12 直接复用）：
- `compiler._expand_subworkflow`（line 837）：把 `nested:subworkflow` 节点的 `params.subworkflow`（inline/template spec，`parse_subworkflow_spec` 解析）递归编译为子 `CompiledStateGraph`（`checkpointer=None`），带嵌套深度限制 + 模板循环检测。
- `compiler._make_subworkflow_node_fn`（line 547）：父图节点适配器——按 `mapping.inputs` 从父 state 读入、`_copy_on_write` 跨界、`await child.ainvoke(...)`、按 `mapping.outputs` 回写父 state；**子图异常被包成 `WorkflowExecutionError(f"{node.id} > {exc}")`**。
- `_validate_subworkflow_mapping`（line 889 调用）校验 mapping 端口存在性。

**关键约束**：
- 子图内 `require_approval` / `human:task` 需要 `human_task_repo`，当前在子图内不支持（`approval.py` line 177 / `human.py` line 65 明确报错）。
- `interrupt()`（HITL 挂起）在 LangGraph 里以 `GraphInterrupt` 异常抛出——**catch 绝不能吞它**，否则会破坏断点/人工挂起语义。`GraphRecursionError`（递归上限）同理应上抛（可配）。
- 节点事件 `depth`：worker 只转发 `depth==0`，子图内 body 节点事件本来就不发（与 `nested:subworkflow` 一致）。

**前端**：`node-catalog.ts` / `types.ts`（`NODE_TYPES`）/ `validation.ts` 目前无 try/catch 节点类型。

---

## 二、目标语义

1. **Try-Catch**：受保护的一段执行（body）抛错时，不炸整个 run，而是把错误写成输出端口并让流程走 **catch 分支**（失败降级由 catch 分支表达）。
2. **Finally**：无论成败都执行的一段收尾。
3. 保持既有 run 生命周期与错误语义（未声明 try 的图行为**零变化**）。

---

## 三、Option A（推荐，低风险）：`flow:try` = 受保护子工作流

新增**一个**节点类型 `flow:try`，**复用现成的子图展开 + mapping 机制**承载 body；错误不通过条件边新机制，而是写成普通输出端口，由已有 `flow:if` 读 `error` 分流。

### A1. 节点与参数
- `NodeType.FLOW_TRY = "flow:try"`。
- 参数：
  - `subworkflow`：**body** 的 inline/template spec（与 `nested:subworkflow` 同形状，复用 `parse_subworkflow_spec`）。
  - `finally_subworkflow`（可选）：收尾子工作流，同形状。
  - `mapping`：`{inputs, outputs}`（复用 `_validate_subworkflow_mapping`；body 用）。
  - `on_error`：`catch`（默认）｜`fail`（保持今天行为：原样上抛 → run error）。
  - `catch_recursion`：`false`（默认，`GraphRecursionError` 上抛）｜`true`（也捕获）。
- 端口：
  - 入：`in`（+ mapping 声明的 body 输入）。
  - 出：`out`（body 成功结果）、`error`(bool)、`error_message`(data)、`error_type`(data)。

### A2. 编译与执行
- `_compile_impl` 中 `FLOW_TRY` 分支：`_expand_subworkflow(node, ...)` 编译 body；若声明 `finally_subworkflow` 再编译一个 finally 子图。
- try 节点 fn：
  1. 读父 state 输入（复用 input_key_map）。
  2. `try:` `await body.ainvoke(sub_input)` → 成功：按 mapping 回写 `out`，`error=False`。
  3. `except (`WorkflowExecutionError`, `Exception`) as exc:`（**排除 `GraphInterrupt`、`CancelledError`，`GraphRecursionError` 视 `catch_recursion`**）→ `error=True`、`error_message=str(exc)`、`error_type=type(exc).__name__`，继续（不抛）。
  4. `finally:` 若声明 finally 子图 → `await finally.ainvoke(...)`（其自身异常按 `on_error` 决定吞/抛）。
- `on_error="fail"` 时第 3 步改为 `raise`（等价今天行为）。

### A3. 路由（不新增条件边机制）
- `flow:try` 是**普通节点**（非条件节点）。作者用已有 `flow:if` 读 `wf:<try>:error` 分流：
  - `if(error)` → catch 分支（降级/回退/通知）；
  - else → 成功分支；
  - finally 收尾由 `finally_subworkflow`（A1）承担，或作者自行汇聚。
- 这样 **Pass A/B 条件边逻辑零改动**，风险最小。

### A4. 兼容 / 迁移
- 纯新增节点类型 + 新参数；未使用 `flow:try` 的定义字节不变。
- **无 schema 迁移、无新表、无新配置段、无新依赖**（复用 `langgraph` 既有异常类型）。

### A5. 前端（本切片）
- `types.ts` `NODE_TYPES` + `node-catalog.ts`（`flow:try`：入 `in`；出 `out`/`error`/`error_message`/`error_type`；category `flow`）+ `node-catalog.test.ts`。
- 表单：`flow:try` 的 `subworkflow` 作者方式与 `nested:subworkflow` 一致（inline 走 API/生成；表单字段留后续）。

### A6. 测试（TDD）
- body 成功 → `out` 有值、`error=False`、走成功分支。
- body 抛 `WorkflowExecutionError` → `error=True`、`error_message` 含节点链、run 不炸、走 catch 分支；catch 分支产物可回写。
- `on_error="fail"` → 异常照旧上抛（run error）。
- **`interrupt()` 不被吞**（body 内挂起 → 正常挂起/恢复，不落入 catch）。
- finally 子图：成功也跑、失败也跑。
- `GraphRecursionError` 默认上抛、`catch_recursion=true` 时捕获。
- 回归：`nested:subworkflow` / loop / 全量离线 A/B 对拍。

### A7. 工作量 / 风险
- 改动集中在 `compiler.py`（新增 `FLOW_TRY` 分支 + 一个 node fn 构造器）+ 前端目录 + 测试。
- 复用现有子图/mapping/校验，不碰条件边/事件/checkpointer 主路径 → 风险低。
- **已知边界**（沿用 `nested:subworkflow`）：body 内 `require_approval`/`human:task` 仍不支持（需 repo，子图内报错）；body 节点 SSE 事件不发（depth>0，与子图一致）。

---

## 四、Option B（完整「图上画区域」）

在画布上平铺画 `try` / body / `catch` / `finally` 节点，编译器做**区域识别**（从 `try` 的出边界定 body 区域）并把 body 区域子图展开，`catch`/`finally` 作为汇聚节点。

- **收益**：最贴合「Try-Catch/Finally 节点」的字面（可视化区域）。
- **代价**：区域识别（同 loop body 界定，但边界不如回边清晰）；body 子图展开带来的事件 depth / 中断语义 / `validate_definition` 环豁免迁移；`catch`/`finally` 节点的语义与路由；工作量与风险数倍于 A。
- **建议**：先落 A（满足「子图异常捕获走 catch 分支 + 失败降级」），把「平铺区域 + 显式 finally 节点」列为后续增量。

---

## 五、待确认决策

- **D1**：范围 **Option A（推荐）** vs Option B。
- **D2**：`flow:try` 复用 `subworkflow`（inline/template）+ `mapping` 承载 body —— 确认。
- **D3**：异常分类：捕获 `Exception`，**排除 `GraphInterrupt`/`CancelledError`**；`GraphRecursionError` 默认上抛（`catch_recursion=true` 可捕获）—— 确认。
- **D4**：端口 `out`/`error`(bool)/`error_message`/`error_type` —— 确认。
- **D5**：路由交给已有 `flow:if`（不新增条件边机制）—— 确认。
- **D6**：`finally` 用 try 节点内 `finally_subworkflow`（可选）表达（显式 `flow:finally` 节点留后续）—— 确认。
- **D7**：节点级重试（`retry`）**不**纳入本切片（N7 调度层已有退避/DLQ；节点级重试后续）—— 确认。
- **D8**：前端本切片接入目录（`types.ts`/`node-catalog.ts`+测试），表单字段后续 —— 确认。

---

## 六、验收标准
- 含 `flow:try` 的工作流可编译、执行：body 成功走成功分支、抛错走 catch 分支且 run 不炸；`error`/`error_message`/`error_type` 正确；`on_error="fail"` 保持旧上抛；`interrupt()` 不被吞；finally 无论成败都执行。
- 未使用 `flow:try` 的定义行为不变；全量离线回归失败集合逐条一致；ruff + 前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`（workflow/compiler.py、node 类型枚举）、`backend/AGENTS.md`（如涉及）、`HNFlow 开发规划.md` N12/M2 状态。
