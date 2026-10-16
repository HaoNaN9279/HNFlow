# N14-切片AA N1 §9：MCP 收编为工具网关 provider —— 执行计划

> 来源：《HNFlow 开发方案.md》第九节（统一工具网关 + provider 分派，MCP 收编为 provider）与规划 §25「工具网关落地」。
> 状态：**已完成**。

## 范围

- `tool_gateway.PROVIDER_MCP` + `_mcp_tools()`（独立 provider）。
- `_builtin_tools` 装配改 `include_mcp=False`。
- 注册顺序 `sandbox → builtin → mcp → app`。
- `tests/test_workflow_tool_gateway.py` 增 6 条。

## 关键不变量

- MCP 工具必须保留 `tag_mcp_tool` 标记（deferred-tool 过滤依赖）；
  装配从 builtin 移到 mcp provider 后，标记要跟着走。
- fail-open：无启用 server / 未装 MCP extra / 配置异常 → provider 为空 + 告警。
- 未知 provider 不回落（N14z 已定）；MCP 不再遮蔽同名 builtin。

## 取舍

- 注册顺序把 MCP 放在 builtin 之后（诚实归因 + 让内置名先胜）。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 6 条新测试全过；全量 A/B 无新增失败（74，基线 75 中一条本次通过）；ruff 干净。
