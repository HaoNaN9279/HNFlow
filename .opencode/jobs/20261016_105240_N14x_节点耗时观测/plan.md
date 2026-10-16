# N14-切片X 节点耗时观测 + 执行数据分析（§25）—— 执行计划

> 来源：《HNFlow 开发方案.md》§二十五『执行数据分析：节点耗时统计、瓶颈识别、Token 预算告警 UI』（后端半边）。
> 状态：**已完成**（后端观测与聚合）。

## 范围

- compiler：执行段计时 → 保留通道 `wf:<node>:__duration_ms`（每个节点类型都声明）。
- worker：`run.end` content additive `node_timings`。
- dispatch：`get_workflow_run` additive `node_timings`。
- 事件契约收紧：节点事件的 `output` 只含声明端口。

## 取舍

- 只测**执行段**（不含审批/人工等待）；replay 命中不写。
- `slowest_node` tie-break 按 node id（稳定报告）。
- 瓶颈识别 UI 属前端增量；缓存感知规划器「待 benchmark 后立项」，不在范围。
- 无迁移/无新表/无新配置段/无新依赖。

## 验收

- 12 条新测试全过；全量 A/B 仅既有 flake 差异；ruff 干净。
