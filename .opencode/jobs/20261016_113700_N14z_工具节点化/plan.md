# N14-切片Z §25 工具节点化（`tool:invoke`）—— 执行计划

> 来源：《HNFlow 开发方案.md》§二十五『工具节点化：应用 / MCP 工具直接调用节点，当前仅经工具网关 / AI 节点工具集可用』。
> 状态：**已完成**。

## 范围

- `schema.NodeType.TOOL_INVOKE`（`tool:invoke`）。
- `executors/tool.py::exec_tool_invoke` + 直调路径 `_call_tool` + `{{port}}` 插值。
- `tool_gateway.ToolGateway`：`resolve(..., provider=...)` / `provider_names()` / `resolve_with_provider()`（additive）。
- registry/danger 归类（非幂等 + crash-confirm + 待人工审核）。
- 前端 palette（`tool:invoke`）。

## 关键实测坑

- 模块 `from __future__ import annotations` 时，`InjectedToolArg` 退化为字符串 →
  框架把注入参数填 `None` **并忽略 args 里的同名值**（最小复现已确认）。
  → 故走直调路径：自 schema 校验 + **仅当签名声明 `runtime` 才传 `ToolRuntime`**。
- `resolve` 未知 provider **不回落**（typo 不得挑到别的工具）。
- 网关缺失 **fail-loud**（就地新建会解析出与准入时不同的工具集）。

## 取舍

- 非幂等 + crash-confirm 门 + 默认待审核（与 bash/http 同处理）→ 编译期拒绝 `params.retry`。
- 透明 `BaseTool` 子类回落框架路径（唯一不保证注入的情形，docstring 明写）。
- 无迁移/无新表/无新配置段/无新依赖。

## 验收

- 22 条新测试全过；全量 A/B 唯一差异为既有 flake；ruff + 前端 check/format 全绿。
