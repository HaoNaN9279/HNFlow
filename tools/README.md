# Tool packages

工具包是可执行能力的唯一载体。能力组只引用工具 ID，不拥有工具定义。

```text
tools/<name>/<version>/tool.json
```

```json
{
  "schema_version": 1,
  "guid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "name": "query-sales",
  "tool_name": "query_sales",
  "version": "0.1.0",
  "description": "Query sales data",
  "provider": "python",
  "entrypoint": "query_sales:main",
  "permissions": ["fs"],
  "idempotent": true,
  "source": { "type": "local" },
  "run": { "kind": "uv", "command": "query-sales" },
  "mcp": null
}
```

- `guid`：32 位小写十六进制，所有版本保持不变。
- `name` / `version`：必须与目录名一致。
- `provider`：`python`、`mcp`、`builtin`、`sandbox`、`app`。
- `python`：`entrypoint` 为 `<module>:<attr>`；`run` 描述 `uv` 命令。
- `mcp`：MCP 服务器配置，由 Agent 插件注入。
- `permissions`：`fs`、`net`、`exec`、`secrets` 的子集。

能力组引用：

```json
{
  "tools": ["tool:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@v0.1.0"],
  "tool_permissions": {
    "tool:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@v0.1.0": ["fs"]
  }
}
```

统一入口：

```bash
hnflow-stack tool list
hnflow-stack tool run <tool> -- <args>
hnflow-stack tool serve <tool>
hnflow-stack tool exec <tool> -- python -m <module>
```

GitHub 来源的工具必须记录 `source.url`、`source.commit`、`source.tag`。
