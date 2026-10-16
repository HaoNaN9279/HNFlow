# N14-切片AI §24.12 工具级权限裁决 —— 执行计划

> 来源：《HNFlow 开发方案.md》§24.12「Agent 威胁模型与注入防御」（计划表 P0）中的
> 「最小权限：工具级权限 + 能力包 permissions（fs/net/exec/secrets）运行时裁决」。
> 状态：**已完成**（注入防御侧 N14m 已落地；本切片补最小权限侧）。

## 范围

- `skills/permission_policy.py`：需求表 + `adjudicate`/`adjudicate_tools`（纯逻辑）。
- `resolve_capability_tools` 装配前按能力组并集裁决并过滤（逐条记录理由）。
- frontmatter `tool-permissions: {tool: [perms]}`（表外工具）+ `Skill.tool_permissions`
  + `composition` 逐工具并集 + `contract` 校验。

## 三条刻意性质

1. **opt-in**：未声明 permissions 的组不受限（既有行为零变化）。
2. **无法归类即 fail-closed**：表外工具（含 MCP）拒绝，拒绝文案点名 `tool-permissions`。
3. **声明而非猜测**：覆盖字段存在，否则 fail-closed 不可用。

## 取舍

- 裁决在 AI 节点装配处；`tool:invoke` 节点与对话侧工具集不走该路径（各自有 crash-confirm/审批语义）。
- 表按工具名匹配，provider 仅作精确化参数。
- MCP 未声明覆盖 + 落入受限组 = 被拒（有意 fail-closed）。

## 验收

- 新增 31 条测试全过；全量 A/B 11454→11485 passed，失败集合与基线逐条一致（75 = 75）。
- 顺带修复：`Skill` 新增 dict 字段导致 frozen 不可哈希（`test_frozen_catalog_is_hashable`），
  已 `hash=False, compare=True` 并注明理由。
