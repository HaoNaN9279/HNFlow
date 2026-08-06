/**
 * 状态型 MCP Server 测试夹具。
 *
 * 用途：验证进程池对「状态型 Server」的行为——进程内保存状态，
 * 进程崩溃/重启后状态归零，进程池应自动拉起全新实例。
 *
 * 工具：
 *   - counter_increment: 无入参，计数自增 1，返回 { count: N }（初始 0）
 *   - counter_reset:     无入参，计数归零，返回 { count: 0 }
 *   - get_counter:       无入参，返回 { count: N }
 *
 * 状态语义：计数只保存在当前进程内存中，进程崩溃/重启后重新从 0 开始。
 *
 * 启动方式：
 *   bun run tests/fixtures/mcp/stateful-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "hnflow-test-stateful-server",
  version: "0.4.2",
});

// 进程内计数状态：仅存在于当前进程，崩溃/重启后归零。
let counter = 0;

// counter_increment：计数自增 1 并返回当前值。
server.registerTool(
  "counter_increment",
  {
    description: "进程内计数自增 1，返回当前计数",
  },
  async () => {
    counter += 1;
    return { content: [{ type: "text", text: JSON.stringify({ count: counter }) }] };
  },
);

// counter_reset：计数归零并返回 0。
server.registerTool(
  "counter_reset",
  {
    description: "进程内计数归零，返回 0",
  },
  async () => {
    counter = 0;
    return { content: [{ type: "text", text: JSON.stringify({ count: 0 }) }] };
  },
);

// get_counter：返回当前计数，不修改状态。
server.registerTool(
  "get_counter",
  {
    description: "返回当前进程内计数",
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({ count: counter }) }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("stateful-server 启动失败:", error);
  process.exit(1);
});
