---
name: custom-tool
description: 当用户需要创建或管理 HNFlow 工具包时使用
license: MIT
---

# Custom Tool — 工具包制作指南

工具包是可执行能力的唯一载体。能力组只声明引用，不包含工具代码。

---

## 1. 目录

```text
tools/<name>/<version>/
├── tool.json
├── pyproject.toml          # Python 工具
├── src/                    # 可选
├── tests/                  # 可选
└── README.md
```

---

## 2. tool.json

```json
{
  "schema_version": 1,
  "guid": "32位小写hex",
  "name": "video-transcribe",
  "tool_name": "video_transcribe",
  "version": "0.1.0",
  "description": "视频转写工具",
  "provider": "python",
  "entrypoint": "video_transcribe:main",
  "permissions": ["fs", "exec", "net"],
  "idempotent": false,
  "source": { "type": "local" },
  "run": {
    "kind": "uv",
    "command": "video-transcribe"
  },
  "mcp": null
}
```

---

## 3. 字段说明

| 字段 | 说明 |
|---|---|
| `schema_version` | 固定为 `1` |
| `guid` | 32 位小写十六进制，所有版本保持不变 |
| `name` / `version` | 必须与目录名一致 |
| `tool_name` | CLI 或 MCP 使用的工具名，可与 `name` 不同 |
| `provider` | `python`、`mcp`、`builtin`、`sandbox`、`app` |
| `entrypoint` | Python 入口，格式 `<module>:<attr>` |
| `permissions` | `fs`、`net`、`exec`、`secrets` 的子集 |
| `idempotent` | 重复执行是否产生相同结果 |
| `run` | Python 工具运行配置：`kind: uv`、`command`、`serve_command` |
| `mcp` | 可选 MCP 配置；插件据此注入 MCP |
| `source` | `local`、`builtin` 或 `git`（含 `url`、`commit`、`tag`） |

---

## 4. Provider 行为

| provider | CLI | MCP |
|---|---|---|
| `python` | `uv run --project <tool-dir> <run.command>` | `uv run --project <tool-dir> <run.serve_command>` |
| `mcp` | 不支持，提示改用 `tool serve` | 直接执行 `mcp.command` |
| `builtin` / `sandbox` / `app` | 保留扩展位 | 保留扩展位 |

约束：

- `python` 工具必须包含 `pyproject.toml`。
- 首次运行自动执行 `uv sync --project <tool-dir>`。
- 工具 ID 格式：`tool:<guid>@v<version>`。

---

## 5. 能力组引用

```json
{
  "tools": ["tool:<guid>@v0.1.0"],
  "tool_permissions": {
    "tool:<guid>@v0.1.0": ["fs", "exec", "net"]
  }
}
```

---

## 6. 命令

```bash
hnflow-stack tool list
hnflow-stack tool run <tool> -- <args>
hnflow-stack tool serve <tool>
hnflow-stack tool exec <tool> -- python -m <module>
```

`tool exec` 在工具包的 uv 环境中执行任意命令，要求工具包含 `pyproject.toml`。

---

## 7. 规则

- 不在能力组内放 `pyproject.toml`、`tools/` 或工具源码。
- 不写死仓库绝对路径；统一通过 `hnflow-stack` 调用。
- GitHub 来源的工具重新部署时记录 `source.url`、`source.commit`、`source.tag`。
- 已发布版本目录不可修改；升级新增版本目录。
- 不把模型权重、构建产物、`.venv` 提交到仓库。
