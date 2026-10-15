# N14-切片L 多智能体拓扑模板（§24.6a 余 + §24.6b）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.6a（有界评审回环 / 受控动态 handoff）+ §24.6b（supervisor/critic 拓扑模板，画布可插入 UX 糖）。
> 状态：**已完成**（模板 builder 部分）。

## 范围

- `workflow/patterns.py`（纯 builder，返回 `WorkflowDefinition`）：
  - `critic_review_loop`：producer↔critic 有界评审回环，`flow:loop` + `params.continue_on="needs_revision"` + `iterations` 硬上限。
  - `supervisor_topology`：supervisor（ai）写 `decision` → `flow:switch` 运行期分派专家；默认直通 end。
  - `TEMPLATES` 命名表。

## 取舍

- 全部用**既有节点类型**表达，无新引擎行为、无 schema/前端计数改动。
- 前端「插入模板」UI + 受控动态 handoff 的结构化消息契约 = 后续增量。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 两模板过 `validate_definition` 且可 `compile_definition`；回环运行语义正确（批准退出 + 上限硬停）；supervisor 分派正确。
- 全量离线 A/B 无实质新增失败；ruff 干净。
