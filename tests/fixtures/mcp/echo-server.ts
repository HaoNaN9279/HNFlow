/**
 * 无状态 MCP Server 测试夹具。
 *
 * 用途：验证进程池对「无状态 Server」的行为（启动、工具调用、进程任意回收均安全）。
 *
 * 工具：
 *   - echo:     入参 text，返回 "echo: " + text
 *   - get_time: 无入参，返回当前 ISO 8601 时间
 *
 * 无状态语义：工具调用不保存任何跨调用状态，进程崩溃/重启无副作用。
 *
 * 启动方式：
 *   bun run tests/fixtures/mcp/echo-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({
  name: "hnflow-test-echo-server",
  version: "0.4.2",
});

// echo：把传入 text 拼前缀返回，验证参数透传。
server.registerTool(
  "echo",
  {
    description: "返回入参 text，前缀为 echo: ",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }),
);

// get_time：无入参，返回当前 ISO 8601 时间。
server.registerTool(
  "get_time",
  {
    description: "返回当前 ISO 8601 时间",
  },
  async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("echo-server 启动失败:", error);
  process.exit(1);
});
