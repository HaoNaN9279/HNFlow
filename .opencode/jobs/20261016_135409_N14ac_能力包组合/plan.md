# N14-切片AC 能力包组合机制（extends/overlay，§5.5）—— 执行计划

> 来源：《HNFlow 开发方案.md》§5.5「能力包体系：组合机制（extends/overlay）」+ 规划 §25「能力包体系落地」。
> 状态：**已完成**（组合机制）。

## 范围

- `skills/composition.py`（**纯逻辑**）：`resolve_declaration` / `resolve_allowed_tools` /
  `resolve_group_closure` / `validate_composition` / `CompositionError`。
- `skills/types.Skill`：`extends` + `overlay` 字段。
- `skills/parser.py`：`parse_extends` / `parse_overlay`（**坏形状 fail-loud**）。
- 消费侧：`tool_gateway.resolve_capability_tools`（工具并集按 extends 解析）、
  `schema.collect_resolved_groups`（快照纳入 extends 闭包）。

## 合并规则（小且可预测）

- `allowed-tools`：base ∪ own；`overlay: true` 时 own **替换** base（可收窄）。
- `permissions` / `required-secrets` / `requirements`：并集。
- `tool-schema-version` / `context-budget`：own 优先，其次最后一个声明它的 base。
- 坏组合（未知 base / 自引用 / 环 / 深度超限）**loud**。

## 取舍

- 解析层 **fail-loud**（与 `dependencies` 同处理）：extends 写错却照常加载 =
  声明继承的工具静默消失，是能力边界最坏的失败形状。
- 工具装配层 **fail-closed for tools**（坏组合 => 无工具 + 告警，不抛）：
  未安装的 base 不该让本来可跑的 workflow 直接失败。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 46 条新测试全过；全量 A/B 无新增失败（唯一差异为既有时序 flake，单跑通过）；ruff 干净。
