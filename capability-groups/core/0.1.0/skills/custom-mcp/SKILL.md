---
name: custom-mcp
description: 当用户需要创建或管理 HNFlow MCP 工具包时使用
license: MIT
---

# Custom MCP — MCP 工具包制作指南

HNFlow 不保存 `mcp/` 目录。MCP 服务器按**工具包**管理，放在 `tools/<name>/<version>/`，由能力组通过 `tools` 字段引用。

---

## 1. 目录

```text
tools/<name>/<version>/
└── tool.json
```

MCP 工具包可以没有源码（远程 MCP），也可以包含本地服务代码（本地 MCP）。

---

## 2. tool.json

必需字段：`schema_version`、`guid`、`name`、`version`、`description`、`provider`。
MCP 相关配置放在 `mcp` 对象中，`provider` 为 `mcp` 或 `python`。

远程 MCP：

```json
{
  "schema_version": 1,
  "guid": "32位小写hex",
  "name": "context7-mcp",
  "tool_name": "context7",
  "version": "1.0.0",
  "description": "Context7 documentation MCP",
  "provider": "mcp",
  "entrypoint": null,
  "permissions": ["net"],
  "idempotent": true,
  "source": { "type": "builtin" },
  "run": null,
  "mcp": {
    "name": "context7",
    "type": "remote",
    "url": "https://mcp.context7.com/mcp",
    "enabled": true
  }
}
```

本地 MCP：

```json
{
  "schema_version": 1,
  "guid": "32位小写hex",
  "name": "excel-mcp",
  "tool_name": "excelMCP",
  "version": "1.0.0",
  "description": "Excel MCP",
  "provider": "mcp",
  "permissions": ["fs", "exec"],
  "idempotent": true,
  "source": { "type": "builtin" },
  "run": null,
  "mcp": {
    "name": "excelMCP",
    "type": "local",
    "command": ["uvx", "excel-mcp-server", "stdio"],
    "enabled": true
  }
}
```

Python MCP 服务（与 CLI 共用工具包）：

```json
{
  "provider": "python",
  "entrypoint": "data_forge.mcp.server:main",
  "permissions": ["fs", "exec", "net"],
  "run": {
    "kind": "uv",
    "command": "data-forge",
    "serve_command": "data-forge-mcp"
  },
  "mcp": {
    "name": "data-forge",
    "type": "local",
    "command": ["hnflow-stack", "tool", "serve", "tool:<guid>@v0.2.1"],
    "enabled": true
  }
}
```

---

## 3. 能力组引用

```json
{
  "tools": ["tool:<guid>@v1.0.0"],
  "tool_permissions": {
    "tool:<guid>@v1.0.0": ["net"]
  }
}
```

`guid` 在所有版本中保持不变。`version` 必须与目录名一致。

---

## 4. 注入

适配器读取能力组引用的工具包：

1. 找到 `tool.json`
2. 读取 `mcp` 对象
3. 注入 `mcp["capability:<group>_<server>"]`
4. 不修改 Agent 主配置文件

`mcp.enabled` 为 `false` 时跳过。不同能力组产生同名 MCP 时，后加载者覆盖。

项目没有 `.hnflow/stack.json` 时：`project` 模式不加载任何能力组；DSH 的 `HNFlow`
模式仍加载 Core，但不加载领域组。

---

## 5. 调试

```bash
hnflow-stack tool list
hnflow-stack tool serve <tool>
hnflow-stack sync
cat .hnflow/lock.json
```

`lock.json` 记录解析后的能力组路径、依赖和工具引用。

---

## 6. 规则

- 不在能力组内创建 `mcp/` 目录。
- MCP 凭据、Token 不写入仓库；使用环境变量。
- 本地 MCP 的启动命令应自包含，不依赖用户机器上的随机路径。
- 新版本新建版本目录，不修改已发布版本。
- 工具代码只放在 `tools/`，能力组只保存引用和说明。
