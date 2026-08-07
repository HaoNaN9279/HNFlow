// 系统信息 MCP Server（v0.5.0 T6）：只读系统信息工具。
// 工具：sys_time / sys_platform / sys_env（白名单，防泄露敏感项）/ sys_uptime。
// 启动方式：bun run src/mcp/servers/system-server.ts（import.meta.main 时连接 stdio，
// 被 import 时不启动，仅导出纯函数供单测）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

/** 环境变量白名单：仅允许读取以下变量，其余一律拒绝（防泄露密钥等敏感项）。 */
export const SYS_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "USERPROFILE",
  "USERNAME",
  "USER",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "LANG",
  "LC_ALL",
  "SHELL",
  "COMSPEC",
  "NODE_ENV",
];

/** 白名单查询：命中返回环境变量值，未命中返回 undefined（调用方拒绝）。 */
export function readAllowedEnv(name: string): string | undefined {
  if (!SYS_ENV_ALLOWLIST.includes(name)) {
    return undefined;
  }
  return process.env[name];
}

/** 进程启动时间（模块加载时记录，供 sys_uptime 使用）。 */
const STARTED_AT = Date.now();

const server = new McpServer({
  name: "hnflow-system",
  version: "0.5.0",
});

// sys_time：无参，返回当前 ISO 8601 时间。
server.registerTool(
  "sys_time",
  { description: "返回当前时间（ISO 8601 字符串）" },
  async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
  }),
);

// sys_platform：无参，返回平台 / 架构 / Node 版本。
server.registerTool(
  "sys_platform",
  { description: "返回平台、架构、Node 版本" },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          node: process.version,
        }),
      },
    ],
  }),
);

// sys_env：查询白名单环境变量，未授权返回 allowed:false（防泄露敏感项）。
server.registerTool(
  "sys_env",
  {
    description: "返回指定环境变量值（仅白名单变量；敏感项拒绝）",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const value = readAllowedEnv(name);
    if (value === undefined) {
      return {
        content: [{ type: "text", text: JSON.stringify({ name, allowed: false, value: null }) }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ name, allowed: true, value }) }] };
  },
);

// sys_uptime：无参，返回进程运行时长与启动时间。
server.registerTool(
  "sys_uptime",
  { description: "返回进程运行时长（毫秒）与启动时间" },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          uptimeMs: Date.now() - STARTED_AT,
          startedAt: new Date(STARTED_AT).toISOString(),
        }),
      },
    ],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 直接执行（bun run）时连接 stdio；被 import（单测）时不启动，仅导出纯函数。
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("system-server 启动失败:", error);
    process.exit(1);
  });
}
