// mcpTool 节点测试（v0.4.3 验收 2）：参数解析、MCP 池缺失、mock 池端到端、
// 真实 echo-server、acquire 失败中文错误。
// 子进程清理：afterEach 统一 dispose 进程池，严禁残留长驻子进程。
import { afterEach, describe, expect, test } from "bun:test";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { McpServerPool } from "../src/mcp/pool.js";
import type { McpServerConfig } from "../src/mcp/types.js";
import type { Node } from "../src/model/types.js";
import {
  InvalidMcpToolParamsError,
  McpPoolUnavailableError,
  McpToolCallError,
  mcpToolNode,
} from "../src/nodes/mcpTool.js";

/** 已创建的进程池，逐个测试后统一 dispose 清理（无残留子进程）。 */
const pools: McpServerPool[] = [];

function createPool(): McpServerPool {
  const pool = new McpServerPool({ idleTimeoutMs: 200 });
  pools.push(pool);
  return pool;
}

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type, name: id, params, inputs: [], outputs: [] };
}

/** 节点级 mock ctx：可注入 mcpPool（参照 ai-node-mcp.test.ts 惯例）。 */
function makeContext(node: Node, pool?: McpServerPool): NodeExecutionContext {
  const store: Record<string, unknown> = {};
  return {
    node,
    workflowId: "test-wf",
    ...(pool === undefined ? {} : { mcpPool: pool }),
    get(scope, key) {
      return store[`${scope}:${key}`];
    },
    set(scope, key, value) {
      store[`${scope}:${key}`] = value;
    },
    getByPath(path) {
      return store[path];
    },
    setByPath(path, value) {
      store[path] = value;
    },
    getAll(scope) {
      const result: Record<string, unknown> = {};
      const prefix = `${scope}:`;
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          result[key.slice(prefix.length)] = store[key];
        }
      }
      return result;
    },
    suspend() {
      throw new Error("suspend not implemented in test mock");
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

afterEach(async () => {
  while (pools.length > 0) {
    const pool = pools.pop();
    if (pool !== undefined) {
      await pool.dispose();
    }
  }
});

/** mock 会话：callTool 返回固定值，供 mock 池端到端用例。 */
interface MockMcpSession {
  readonly config: McpServerConfig;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; raw: unknown }>;
}

describe("mcpTool 节点", () => {
  test("ctx 无 mcpPool → McpPoolUnavailableError", async () => {
    const node = makeNode("n1", "mcpTool", {
      serverName: "echo-server",
      toolName: "echo",
      mcpConfig: { command: "bun" },
    });
    const ctx = makeContext(node);
    await expect(mcpToolNode.execute(ctx)).rejects.toThrow(McpPoolUnavailableError);
  });

  test("mock 池端到端：acquire 收到合并配置，callTool 固定值 → { result }", async () => {
    let acquiredConfig: McpServerConfig | undefined;
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const mockSession: MockMcpSession = {
      config: { name: "echo-server", command: "bun" },
      async callTool(name, args) {
        calls.push({ toolName: name, args });
        return { text: "mock-echo", raw: null };
      },
    };
    const mockPool = {
      acquire: async (config: McpServerConfig) => {
        acquiredConfig = config;
        return mockSession;
      },
    } as unknown as McpServerPool;
    const node = makeNode("n1", "mcpTool", {
      serverName: "echo-server",
      toolName: "echo",
      mcpConfig: { command: "bun", args: ["run", "tests/fixtures/mcp/echo-server.ts"] },
      args: { text: "hi" },
    });
    const ctx = makeContext(node, mockPool);
    const result = await mcpToolNode.execute(ctx);
    expect(acquiredConfig).toEqual({
      name: "echo-server",
      command: "bun",
      args: ["run", "tests/fixtures/mcp/echo-server.ts"],
    });
    expect(calls).toEqual([{ toolName: "echo", args: { text: "hi" } }]);
    expect(result["result"]).toBe("mock-echo");
  });

  test("真实 echo-server：callTool echo → result 含 echo: hi", async () => {
    const pool = createPool();
    const node = makeNode("n1", "mcpTool", {
      serverName: "echo-server",
      toolName: "echo",
      mcpConfig: { command: "bun", args: ["run", "tests/fixtures/mcp/echo-server.ts"] },
      args: { text: "hi" },
    });
    const ctx = makeContext(node, pool);
    const result = await mcpToolNode.execute(ctx);
    expect(result["result"]).toContain("echo: hi");
  }, 20000);

  const invalidCases: Array<{
    label: string;
    params: Readonly<Record<string, unknown>>;
  }> = [
    { label: "缺 serverName", params: { toolName: "echo", mcpConfig: { command: "bun" } } },
    { label: "缺 toolName", params: { serverName: "s", mcpConfig: { command: "bun" } } },
    { label: "缺 mcpConfig", params: { serverName: "s", toolName: "echo" } },
    { label: "mcpConfig.command 缺失", params: { serverName: "s", toolName: "echo", mcpConfig: { args: [] } } },
    { label: "mcpConfig 非对象", params: { serverName: "s", toolName: "echo", mcpConfig: "bun" } },
  ];
  test.each(invalidCases)("参数非法：$label → InvalidMcpToolParamsError", async ({ params }) => {
    const node = makeNode("n1", "mcpTool", params);
    const ctx = makeContext(node);
    await expect(mcpToolNode.execute(ctx)).rejects.toThrow(InvalidMcpToolParamsError);
  });

  test("acquire 失败（command 不存在）→ 中文错误携带 server/tool", async () => {
    const pool = createPool();
    const node = makeNode("n1", "mcpTool", {
      serverName: "broken-server",
      toolName: "echo",
      mcpConfig: { command: "nonexistent-cmd-xyz", args: [] },
    });
    const ctx = makeContext(node, pool);
    await expect(mcpToolNode.execute(ctx)).rejects.toThrow(McpToolCallError);
    await expect(mcpToolNode.execute(ctx)).rejects.toThrow("MCP 工具调用失败");
    await expect(mcpToolNode.execute(ctx)).rejects.toThrow("broken-server");
    await expect(mcpToolNode.execute(ctx)).rejects.toThrow("echo");
  }, 20000);
});
