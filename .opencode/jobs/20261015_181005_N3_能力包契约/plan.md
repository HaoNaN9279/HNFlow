# N3 能力包契约（§5.5）—— 执行计划

> 来源：《HNFlow 开发方案.md》§5.5：能力包声明并在导入/升级时校验 permissions / evals / tool_schema_version / context_budget / required-secrets。
> 状态：**已完成**（除 evals 与运行时权限裁决）。

## 范围

- `skills/types.py`：`Skill` 增 `permissions` / `tool_schema_version` / `context_budget`（默认空）。
- `skills/parser.py`：`parse_permissions` / `parse_tool_schema_version` / `parse_context_budget`（fail-soft：未知权限/非正预算/空版本丢弃并告警，不使包不可加载），并接入 `parse_skill_file`。
- `skills/contract.py`（纯逻辑）：`CAPABILITY_PERMISSIONS` + `validate_capability_contract(skill)`（程序化构造的 Skill 的事后校验）。
- 前端 `frontmatter` 定义同步（install 接受标准可选字段，无需改）。

## 取舍

- `required-secrets` 已存在（issue #3861）；本切片补 permissions/schema 版本/预算。
- `evals` 契约（示例任务 + 断言）与**运行时由工具网关裁决 permissions** = 后续增量。
- 无迁移/无新表/无新配置段/无新依赖。

## 验收

- SKILL.md 声明三个字段被正确解析；非法值 fail-soft 丢弃；`validate_capability_contract` 检出问题。
- 全量离线 A/B 失败集无新增；ruff 干净。
