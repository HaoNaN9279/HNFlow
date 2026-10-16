# N14-切片AK `flow:loop` 声明式 body（`params.subworkflow`）—— 执行计划

> 来源：§25 路线图最后一项。此前 loop body 只能手画（`loop --cond--> body` +
> `body --> loop`）；本切片让 body 成为 params 声明的子图（inline/template 皆可），
> 于是可复用模板、不必重画。
> 状态：**已完成**（后端切片；无迁移/无新表/无新配置/无前端改动）。

## 语义（与内联 body 等价，不是新语义）

- body 由 compiler 展开为生成节点（id `<loop>.body`，**不发射节点事件**）+ 生成回边。
- 每轮输入（第 1 轮=种子，其后=上一轮结果，即 ring）经保留通道 `wf:<loop>:__ring` 往返。
- 因此 `results`/`last`/`continue_on` 三种语义**一行都不用改**。

## 三条设计取舍

1. **params 是路由唯一真相**：声明式 body 下画条件出边 = 编译期报错（同 `flow:handoff`）；
   必须且只能有一条无条件出边（出口）——0 条出不去、2 条出口歧义，都报错而不任选。
2. **默认可缺省、显式必校验**：`seed_input`/`ring_port` 默认 `in`/`out`，缺省且子图无该端口
   = 合法的「跑 N 次」无 ring body（此时聚合为空，而不是把种子每轮记一次）；
   显式写错端口名 = 编译期报错。
3. **body 失败不是 try**：`<loop> > body > ...` 直接失败；`interrupt` 等控制流信号照常透传。
   想在 body 内容忍失败，就把 `flow:try` 放进 body。

## 顺带修复

编译缓存键过去只折叠 `nested:subworkflow` 的模板内容 → `flow:try`（含 finally）与 loop 的
模板改动不会失效父图缓存。现改为**递归**折叠全部 subworkflow 引用。

## 验收

- 新增 `tests/test_workflow_loop_body.py` 22 条（ring/聚合/上限/无 ring/mapping/失败/
  continue_on 三种拼写/模板与缓存键/各类编译期拒绝/纯校验器/内联路径未变）。
- 后端全量 A/B：11485 → **11507 passed**，失败集合与基线逐条一致（零新增）。
