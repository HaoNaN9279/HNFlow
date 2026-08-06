# MCP 测试夹具

本目录提供两个可独立运行的 MCP Server（stdio transport），用于 HNFlow MCP 功能测试，特别是进程池相关语义验证。

## 文件

| 文件 | 类型 | 工具 |
| --- | --- | --- |
| `echo-server.ts` | 无状态 | `echo`、`get_time` |
| `stateful-server.ts` | 状态型 | `counter_increment`、`counter_reset`、`get_counter` |

## 启动方式

两个 Server 均通过 stdio 与客户端通信，用 bun 直接启动：

```bash
bun run tests/fixtures/mcp/echo-server.ts
bun run tests/fixtures/mcp/stateful-server.ts
```

启动后等待 stdin 上的 JSON-RPC 消息，不主动退出。

## 无状态 vs 状态型语义

- **无状态（echo-server）**：工具调用不保存任何跨调用状态，进程崩溃/重启无副作用。进程池任意回收、复用均安全。
- **状态型（stateful-server）**：计数只保存在进程内内存中（初始 0）。`counter_increment` 自增、`counter_reset` 归零、`get_counter` 查询。进程崩溃/重启后计数自动归零——这正是进程池「状态型 Server 崩溃后自动重置」测试的关键语义：崩溃后新实例从 0 开始。

## 工具说明

### echo-server

- `echo`：入参 `{ text: string }`，返回 `echo: <text>`
- `get_time`：无入参，返回当前 ISO 8601 时间

### stateful-server

- `counter_increment`：无入参，计数自增 1，返回 `{ count: N }`
- `counter_reset`：无入参，计数归零，返回 `{ count: 0 }`
- `get_counter`：无入参，返回 `{ count: N }`

## 依赖

- `@modelcontextprotocol/sdk`（v1.30.0）
- `zod`（v4，通过 `zod/v4` 子路径导入）
