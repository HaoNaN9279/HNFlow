# C5 循环正宗版 — 执行计划

> 来源：《HNFlow 开发方案》§24（line 995）「Loop 正宗版：子图展开 + 条件边 + `results`/`last` 聚合输出（当前为简单版：`iteration` 轮次计数 + `out` 透传）」；《HNFlow 开发规划.md》C5 行（line 76，⏸ 顺延）、M2 里程碑（line 176）。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `7fe75dc`。
> 状态：**已完成（Option A，D1–D5 按建议）**。提交见 boulder.json `commit`。

---

## 一、现状（简单版，已核对代码）

`backend/packages/harness/deerflow/workflow/compiler.py`：

- `flow:loop` 是**主图**里的一个节点（`_loop_node_fn`，line 1054）。
- 出边：**条件边** → body 入口（`Edge(..., condition="loop_body")`）；**默认边** → exit。
  - 条件串当前**只用于定位 body 入口**，`_make_loop_route`（line 1223）根本没读它。
- body 节点仍在主图；回边 `body → loop`（数据回写 `loop.in`）。
- 每轮 loop fn 写：`wf:<id>:__count`、`wf:<id>:iteration`（=count+1）、`wf:<id>:out`（=in 透传，最后匹配入边键）。
- 路由（line 1229）：`count <= iterations` → body；否则默认（exit）。
- 参数：`iterations`（默认 1）。端口：入 `in`；出 `iteration`/`out`。
- 状态通道（`_build_state_schema`，line 275）：`__count` + 节点声明的输出端口。

**外部契约快照**
- 前端目录 `frontend/src/core/workflows/canvas/node-catalog.ts` line 66：`flow:loop` 输入 `in`，输出 `iteration`/`out`；无 `defaultParams`。
- 测试：`tests/test_workflow_loop_ports.py`（3 条语义，锁 iteration/out/__count）、`tests/test_workflow_executors.py::test_loop_fixed_3_iterations`、`tests/test_workflow_hangup_e2e.py`（非挂起计数回归）。前端 `tests/unit/core/workflows/canvas/node-catalog.test.ts` 锁 `iteration` 端口存在。

**简单版的真实缺陷**（方案 line 726）
1. **不聚合**：每轮 body 输出覆盖 `out`，只有**最后一轮**存活，历史轮结果丢失。
2. **条件边是假的**：退出只由计数决定，无法由 body 产物「评审结论驱动下一轮」（§24.6a 评审回环的前置）。

---

## 二、目标语义

1. **聚合输出**：每轮 body 产物收进 `results`（数组），并暴露 `last`（最后一轮产物）。
2. **条件边成真**：退出可由 body 产出的条件决定（`iterations` 作为**硬上限**兜底），而不仅计数。
3. （方案原文的「子图展开」——见 §四 Option B。）

---

## 三、Option A（推荐，低风险）：原位聚合 + 真条件退出

**不改变图拓扑**（body 仍在主图、回边不变），只增强 loop 节点语义。

### A1. 新增端口与参数
- 新增输出端口：`results`（`array`）、`last`（`data`）——与 `iteration`/`out` **并存**（向后兼容，旧定义零破坏）。
- 新增参数：
  - `continue_on`（可选，字符串）：body 回边 `source_port` 或某个 body 输出端口的**名字**；truthy 则续，否则退出。缺省 = 纯计数循环（= 今天行为）。

### A2. 聚合规则（精确）
loop fn 在第 k 轮被调用时，`in` 值为：
- k=1：seed（上游初始值）；
- k≥2：第 k−1 轮 body 的产物（经回边）。

故聚合：`count >= 1` 时把当前 `in` 追加进 `results`；退出轮（route 判 exit）同样追加。终态 `results = [round1_out, ..., roundN_out]`，`last = results[-1]`。种子不计入。`iterations=0` → `results=[]`、`last=None`。

### A3. 条件退出
路由：`count <= iterations` **且** `continue_on` 为 truthy（或未声明）→ body；否则 exit。`continue_on` 指向的键由回边 `(source, source_port)` 解析为 `wf:<source>:<source_port>`，从 state 读。

### A4. 状态 schema / 前端
- `_build_state_schema` 除 `__count` 外，为 loop 节点补 `wf:<id>:results` / `wf:<id>:last`（**只要节点声明了这两个端口**，避免无谓通道）。
- 前端 `node-catalog.ts` 的 `flow:loop` 增 `results`/`last` 端口；`node-catalog.test.ts` 同步；node-form 增 `continue_on` 可选字段（若表单已有 loop 分支）。

### A5. 兼容 / 迁移
- **纯增量**：老定义（只有 `iteration`/`out`、只给 `iterations`）行为字节不变。
- **无 schema 版本 bump、无迁移**（新增端口不破坏反序列化）。C8 迁移钩子不涉及。

### A6. 测试（TDD）
- `test_workflow_loop_ports.py` 增：`results` 逐轮累积且顺序正确；`last == results[-1]`；`iterations=0` 空结果；body 无产物时 `results` 元素为 None。
- 新 `test_workflow_loop_condition.py`：`continue_on` 早退（body 第 2 轮置假 → 只跑 2 轮）；`iterations` 硬上限仍生效（假条件永不触发时按 iterations 停）；`continue_on` 指向不存在的键的安全默认。
- 回归：`test_workflow_executors.py`、`test_workflow_hangup_e2e.py`、前端目录单测。
- 全量离线 A/B 对拍（stash 前后）确认零回归。

### A7. 工作量 / 风险
- 改动集中在 `compiler.py`（loop fn + route + schema）+ 前端目录/测试。
- 无拓扑变化 → body 节点事件 depth、`require_approval`/`human:task` interrupt、checkpointer 命名空间、子工作流嵌套**全部不受影响**。
- 风险低。

---

## 四、Option B（完整正宗版）：body 子图展开

把 body 节点编译成**子 StateGraph**，loop 节点按轮 `ainvoke` 子图。

- **收益**：语义最"正宗"，body 成为可隔离/可复用的单元。
- **代价 / 破坏面**：
  - body 节点事件 depth 由 0→1，worker 只转发 `depth==0` → **body 节点 SSE 事件消失**（需重定义事件规则）。
  - body 内 `params.require_approval` / `human:task` 的 `interrupt()` 落到子图 → 挂起/恢复语义需重验（现有 `test_workflow_hangup_e2e.py` 明确「loop-internal suspension 是 deliberate non-goal」，B 会推翻此边界）。
  - checkpointer 命名空间、`validate_definition` 的环豁免（环移入子图）、编译缓存键、嵌套深度、in-graph 子工作流互操作。
- **工作量**：数倍于 A；需独立设计子图边界与状态搬运。

> 建议：**先落 Option A**（真满足「条件边 + results/last 聚合输出」），把「子图展开」拆为后续独立切片（待评审回环/§24.6a 需要 body 隔离时再做）。

---

## 五、待确认决策

- **D1**：本次范围选 **Option A**（推荐）还是 Option B？
- **D2**（Option A）：聚合源 = 回边 `in` 值（A2），还是另取一个 body 声明端口？——建议回边 `in`。
- **D3**：`continue_on` 语义 = 命名 body 输出端口（truthy 续）——是否采用？是否同时支持「比较表达式」？（建议只做 truthy，表达式留后续）
- **D4**：新端口 `results`/`last` 是否同时接入前端目录/表单，还是仅后端（前端后续切片）？——建议同切片接入目录。
- **D5**：是否需要 `flow:loop` 的 `iterations` 保持默认 1（当前），`results` 仅在有 body 时写——确认。

---

## 六、验收标准
- Option A：含 loop 的工作流可编译、执行；`results` 收齐每轮产物且顺序正确；`last == results[-1]`；`continue_on` 可早退且 `iterations` 硬上限生效；旧定义行为不变（回归全绿）。
- 全量离线回归与基线失败集合逐条一致；ruff check/format 干净；前端 `pnpm test`+`pnpm check` 绿。
- 文档同步：`backend/AGENTS.md` workflow 段 loop 说明、`HNFlow 开发规划.md` C5/M2 状态、方案无改动。
