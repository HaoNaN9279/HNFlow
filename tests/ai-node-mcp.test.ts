// AI 节点 MCP 工具消费测试（v0.4.2 D2）：
// activeGroups.mcps → 进程池会话 → 工具发现 → 注入 AI 节点工具集。
// E2E：真实引擎 + 功能组 mcp.json 指向 echo-server → fake LLM 调用 MCP 工具返回正确。
// 故障容错：MCP 启动失败 / 配置非法 → warn 跳过，AI 节点仍执行（节点级 + 引擎级）。
// 子图透传：subworkflow 内 AI 节点同样消费 MCP 工具（executeSubEngine 透传 mcpPool）。
// 无 mcp 配置行为不变：既有 ai-node-groups.test.ts 全绿覆盖，此处不重复。
// 子进程清理：afterEach 统一 dispose 进程池，严禁残留长驻子进程。
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { MergedGroups } from "../src/groups/merge.js";
import { McpServerPool } from "../src/mcp/pool.js";
import type { Node, Workflow } from "../src/model/types.js";
import { aiNode } from "../src/nodes/ai.js";
import { registry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\ai-node-mcp-test";

/** 已创建的进程池，逐个测试后统一 dispose 清理（无残留子进程）。 */
const pools: McpServerPool[] = [];

function createPool(): McpServerPool {
  const pool = new McpServerPool({ idleTimeoutMs: 200 });
  pools.push(pool);
  return pool;
}

/** 日志收集：断言 warn 路由用。 */
interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly data: unknown;
}

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** 节点级 mock ctx：可注入 activeGroups + mcpPool（参照 ai-node-groups.test.ts）。 */
function makeNodeContext(
  node: Node,
  logs: LogEntry[] = [],
  groups?: MergedGroups,
  mcpPool?: McpServerPool,
): NodeExecutionContext {
  const store: Record<string, unknown> = {};
  return {
    node,
    workflowId: "test-wf",
    ...(groups === undefined ? {} : { activeGroups: groups }),
    ...(mcpPool === undefined ? {} : { mcpPool }),
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
      info: (msg, data) => logs.push({ level: "info", msg, data }),
      warn: (msg, data) => logs.push({ level: "warn", msg, data }),
      error: (msg, data) => logs.push({ level: "error", msg, data }),
    },
  };
}

/** MergedGroups 夹具：只保留传入字段（exactOptionalPropertyTypes 惯例）。 */
function mergedGroups(overrides: Partial<Omit<MergedGroups, "supplementaryAgents">>): MergedGroups {
  return {
    supplementaryAgents: [],
    tools: [],
    rules: [],
    mcps: [],
    conflicts: [],
    ...overrides,
  };
}

/** 写功能组定义 + v1.0.0/mcp.json（name=echo-server，其余字段透传）。 */
async function writeMcpGroup(
  base: string,
  guid: string,
  namespace: string,
  mcpConfig: Record<string, unknown>,
): Promise<void> {
  const groupDir = join(base, ...namespace.split("/"));
  await mkdir(groupDir, { recursive: true });
  await writeFile(
    join(groupDir, "group.json"),
    JSON.stringify({
      guid,
      namespace,
      aliases: [],
      description: "MCP 功能组",
      currentVersion: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          createdAt: "2026-08-01T00:00:00.000Z",
          changelog: "初版",
          content: { tools: [], mcps: ["mcp.json"], rules: [] },
        },
      ],
    }),
    "utf8",
  );
  const versionDir = join(groupDir, "v1.0.0");
  await mkdir(versionDir, { recursive: true });
  await writeFile(
    join(versionDir, "mcp.json"),
    JSON.stringify({ name: "echo-server", ...mcpConfig }),
    "utf8",
  );
}

/** start → ai → end 工作流（ai 节点 params 由调用方给）。 */
function makeAiWorkflow(aiParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "mcp-wf",
    name: "MCP 工作流",
    version: "0.1.0",
    nodes: [makeNode("start", "start"), makeNode("ai", "ai", aiParams), makeNode("end", "end")],
    edges: [
      { id: "e1", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

afterAll(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
});

afterEach(async () => {
  while (pools.length > 0) {
    const pool = pools.pop();
    if (pool !== undefined) {
      await pool.dispose();
    }
  }
});

describe("AI 节点 MCP 工具消费（v0.4.2 D2）", () => {
  test("E2E：功能组 mcp.json → fake LLM 调用 MCP 工具 → 返回正确", async () => {
    await writeMcpGroup(TEMP_BASE, "g-echo", "echo/demo", {
      command: "bun",
      args: ["run", "tests/fixtures/mcp/echo-server.ts"],
    });
    const pool = createPool();
    const workflow = makeAiWorkflow({
      model: {
        provider: "fake",
        model: "test",
        fakeScript: [
          { kind: "tool_call", toolCall: { name: "echo-server.echo", args: { text: "你好" } } },
          { kind: "text", text: "完成" },
        ],
      },
      inputMessages: "测试 MCP 工具",
      capabilityGroups: [{ guid: "g-echo", version: "1.0.0" }],
    });
    const result = await new ExecutionEngine(workflow, {
      groupsRootDir: TEMP_BASE,
      mcpPool: pool,
    }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("完成");
    expect(result.nodeOutputs["ai"]?.["toolCalls"]).toEqual([
      { name: "echo-server.echo", args: { text: "你好" } },
    ]);
  }, 20000);

  test("子图透传：subworkflow 内 AI 节点消费 MCP 工具", async () => {
    await writeMcpGroup(TEMP_BASE, "g-echo", "echo/demo", {
      command: "bun",
      args: ["run", "tests/fixtures/mcp/echo-server.ts"],
    });
    const pool = createPool();
    const sub: Workflow = {
      id: "sub-mcp",
      name: "子图",
      version: "0.1.0",
      nodes: [
        makeNode("sub-start", "start"),
        makeNode("sub-ai", "ai", {
          model: {
            provider: "fake",
            model: "test",
            fakeScript: [
              { kind: "tool_call", toolCall: { name: "echo-server.echo", args: { text: "子图" } } },
              { kind: "text", text: "子图完成" },
            ],
          },
          inputMessages: "子图测试",
          capabilityGroups: [{ guid: "g-echo", version: "1.0.0" }],
        }),
        makeNode("sub-end", "end"),
      ],
      edges: [
        { id: "s1", sourceNodeId: "sub-ai", sourcePortId: "output", targetNodeId: "sub-end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-mcp",
      name: "父",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sub", "subworkflow", { subworkflow: sub }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent, {
      groupsRootDir: TEMP_BASE,
      mcpPool: pool,
    }).run();
    expect(result.status).toBe("success");
    // 子图 endResult 经 subworkflow 容器 out 端口回到父引擎。
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("子图完成");
  }, 20000);

  test("MCP 启动失败不炸：command 不存在 → warn 跳过，AI 节点仍执行（节点级）", async () => {
    const pool = createPool();
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "ok" }] },
      inputMessages: "你好",
    });
    const ctx = makeNodeContext(
      node,
      logs,
      mergedGroups({
        mcps: [{ name: "broken", config: { command: "nonexistent-cmd-xyz" }, sourceGuid: "g-broken" }],
      }),
      pool,
    );
    const result = await aiNode.execute(ctx);
    expect(result["output"]).toBe("ok");
    const warns = logs.filter((entry) => entry.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]?.msg).toContain("MCP 启动失败");
  }, 20000);

  test("MCP 配置非法不炸：command 缺失 → warn 跳过，不尝试启动（节点级）", async () => {
    const pool = createPool();
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "ok" }] },
      inputMessages: "你好",
    });
    const ctx = makeNodeContext(
      node,
      logs,
      mergedGroups({
        mcps: [{ name: "no-cmd", config: { url: "http://localhost:1" }, sourceGuid: "g-broken" }],
      }),
      pool,
    );
    const result = await aiNode.execute(ctx);
    expect(result["output"]).toBe("ok");
    const warns = logs.filter((entry) => entry.level === "warn");
    expect(warns[0]?.msg).toContain("MCP 配置非法");
  });

  test("引擎级 MCP 故障：mcp.json command 不存在 → 工作流 success，warn 输出", async () => {
    await writeMcpGroup(TEMP_BASE, "g-broken", "broken/demo", { command: "nonexistent-cmd-xyz" });
    const pool = createPool();
    const warn = spyOn(console, "warn");
    try {
      const workflow = makeAiWorkflow({
        model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "ok" }] },
        inputMessages: "你好",
        capabilityGroups: [{ guid: "g-broken", version: "1.0.0" }],
      });
      const result = await new ExecutionEngine(workflow, {
        groupsRootDir: TEMP_BASE,
        mcpPool: pool,
      }).run();
      expect(result.status).toBe("success");
      expect(result.nodeOutputs["ai"]?.["output"]).toBe("ok");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 20000);
});
