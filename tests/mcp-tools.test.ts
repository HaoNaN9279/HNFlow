// MCP 工具转换层测试：JSON-schema→zod、结果规范化、错误传播、真实 SDK Client 端到端。
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toLangChainTool } from "../src/ai/tool.js";
import {
  discoverMcpTools,
  mcpToolToHNFlowTool,
  type McpToolHandle,
} from "../src/mcp/tools.js";

/** 构造 echo 工具 mock 会话：listTools 返回 echo，callTool 回显文本。 */
function makeEchoHandle(): McpToolHandle {
  return {
    listTools: async () => ({
      tools: [
        {
          name: "echo",
          description: "返回入参 text",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    }),
    callTool: async (_name, args) => ({
      content: [{ type: "text", text: `echo: ${String(args["text"])}` }],
    }),
  };
}

describe("mcpToolToHNFlowTool / discoverMcpTools", () => {
  test("转换正确：mock 会话 → HNFlowTool，参数解析与 handler 回显", async () => {
    const tools = await discoverMcpTools(makeEchoHandle(), "demo");
    expect(tools).toHaveLength(1);
    const echo = tools[0];
    if (echo === undefined) throw new Error("echo 工具应存在");
    expect(echo.name).toBe("demo.echo");
    expect(echo.description).toBe("返回入参 text");
    expect(echo.parameters.parse({ text: "hi" })).toEqual({ text: "hi" });
    expect(echo.parameters.safeParse({}).success).toBe(false);
    expect(await echo.handler({ text: "hi" })).toBe("echo: hi");
  });

  test("mcpToolToHNFlowTool 直接转换：fullName 原样使用", () => {
    const handle = makeEchoHandle();
    const tool = mcpToolToHNFlowTool(
      handle,
      { name: "echo", inputSchema: { type: "object", properties: {} } },
      "ns.echo",
    );
    expect(tool.name).toBe("ns.echo");
  });

  test("toLangChainTool 兼容：转换结果可直接 invoke", async () => {
    const tools = await discoverMcpTools(makeEchoHandle(), "demo");
    const echo = tools[0];
    if (echo === undefined) throw new Error("echo 工具应存在");
    const lcTool = toLangChainTool(echo);
    expect(lcTool.name).toBe("demo.echo");
    expect(await lcTool.invoke({ text: "hi" })).toBe("echo: hi");
  });
});

describe("json-schema → zod 映射", () => {
  const handle: McpToolHandle = {
    listTools: async () => ({
      tools: [
        {
          name: "typed",
          description: "类型覆盖工具",
          inputSchema: {
            type: "object",
            properties: {
              s: { type: "string" },
              n: { type: "number" },
              b: { type: "boolean" },
              i: { type: "integer" },
              arr: { type: "array", items: { type: "string" } },
              nested: {
                type: "object",
                properties: { x: { type: "number" } },
                required: ["x"],
              },
              opt: { type: "string" },
              weird: { type: "whatever" },
              noType: {},
            },
            required: ["s", "n", "b", "i", "arr", "nested"],
          },
        },
      ],
    }),
    callTool: async () => ({ content: [] }),
  };

  async function typedTool() {
    const tools = await discoverMcpTools(handle, "types");
    const tool = tools[0];
    if (tool === undefined) throw new Error("typed 工具应存在");
    return tool;
  }

  test("string/number/boolean/integer/array/object 全量解析通过", async () => {
    const tool = await typedTool();
    const result = tool.parameters.safeParse({
      s: "hi",
      n: 1.5,
      b: true,
      i: 2,
      arr: ["a", "b"],
      nested: { x: 3 },
    });
    expect(result.success).toBe(true);
  });

  test("required 缺字段拒绝、可选字段允许缺省", async () => {
    const tool = await typedTool();
    expect(tool.parameters.safeParse({ s: "hi", n: 1, b: true, i: 2, arr: [], nested: { x: 1 } }).success).toBe(
      true,
    );
    expect(tool.parameters.safeParse({}).success).toBe(false);
  });

  test("类型不匹配拒绝：string 传数字、integer 传小数", async () => {
    const tool = await typedTool();
    const base = { s: "hi", n: 1, b: true, i: 2, arr: [], nested: { x: 1 } };
    expect(tool.parameters.safeParse({ ...base, s: 123 }).success).toBe(false);
    expect(tool.parameters.safeParse({ ...base, i: 2.5 }).success).toBe(false);
  });

  test("嵌套 object 必填校验生效", async () => {
    const tool = await typedTool();
    const base = { s: "hi", n: 1, b: true, i: 2, arr: [], nested: { x: 1 } };
    expect(tool.parameters.safeParse({ ...base, nested: {} }).success).toBe(false);
  });

  test("不支持/缺失 type 退回宽容 schema，不拒绝任意值", async () => {
    const tool = await typedTool();
    const base = { s: "hi", n: 1, b: true, i: 2, arr: [], nested: { x: 1 } };
    const result = tool.parameters.safeParse({
      ...base,
      weird: { anything: 1 },
      noType: { any: true },
    });
    expect(result.success).toBe(true);
  });
});

describe("错误传播与结果规范化", () => {
  test("callTool 返回 isError → handler 抛中文错误并携带详情", async () => {
    const handle: McpToolHandle = {
      listTools: async () => ({
        tools: [{ name: "boom", description: "会失败的工具", inputSchema: { type: "object", properties: {} } }],
      }),
      callTool: async () => ({
        content: [{ type: "text", text: "服务器内部错误" }],
        isError: true,
      }),
    };
    const tools = await discoverMcpTools(handle, "demo");
    const boom = tools[0];
    if (boom === undefined) throw new Error("boom 工具应存在");
    await expect(boom.handler({})).rejects.toThrow("MCP 工具调用失败: 服务器内部错误");
  });

  test("多 text 块按序拼接返回", async () => {
    const handle: McpToolHandle = {
      listTools: async () => ({
        tools: [{ name: "multi", inputSchema: { type: "object", properties: {} } }],
      }),
      callTool: async () => ({
        content: [
          { type: "text", text: "第一段" },
          { type: "image", data: "base64", mimeType: "image/png" },
          { type: "text", text: "第二段" },
        ],
      }),
    };
    const tools = await discoverMcpTools(handle, "demo");
    const multi = tools[0];
    if (multi === undefined) throw new Error("multi 工具应存在");
    expect(await multi.handler({})).toBe("第一段第二段");
  });
});

describe("端到端（真实 SDK Client + echo-server）", () => {
  test("discoverMcpTools → handler 返回真实子进程结果", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "tests/fixtures/mcp/echo-server.ts"],
    });
    const client = new Client({ name: "hnflow-test-client", version: "0.4.2" });
    await client.connect(transport);
    try {
      const handle: McpToolHandle = {
        listTools: () => client.listTools(),
        callTool: (name, args) => client.callTool({ name, arguments: args }),
      };
      const tools = await discoverMcpTools(handle, "echo-server");
      expect(tools.map((t) => t.name).sort()).toEqual(["echo-server.echo", "echo-server.get_time"]);
      const echo = tools.find((t) => t.name === "echo-server.echo");
      const getTime = tools.find((t) => t.name === "echo-server.get_time");
      if (echo === undefined || getTime === undefined) {
        throw new Error("echo/get_time 工具应存在");
      }
      expect(await echo.handler({ text: "你好" })).toBe("echo: 你好");
      const timeText = String(await getTime.handler({}));
      expect(timeText.length).toBeGreaterThan(0);
      expect(new Date(timeText).toString()).not.toBe("Invalid Date");
    } finally {
      await client.close();
    }
  }, 15000);
});
