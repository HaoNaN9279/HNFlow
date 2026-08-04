// v0.2.4 AI 轨迹补全 + 执行日志补全（T5）测试：
// invoke 模式 AI 节点也产生工具调用/LLM 消息进度事件并可落日志（SQLite 带 nodeId + data 结构化）；
// stream 模式回归不受影响；引擎节点级 node:start/end/error/waiting 日志；时间线 createdAt 可排序。
// 独立 NodeRegistry + fake-llm（无真实 API）；挂起场景显式传 humanTaskStore。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { clearTools, registerTool } from "../src/ai/toolRegistry.js";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { DebugController } from "../src/execution/DebugController.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import { ExecutionLogStore } from "../src/logs/ExecutionLogStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\debug-ai-trace-test";
let fileCounter = 0;

function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

/** 带重试的递归删除：Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= retries) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY") {
        Bun.gc(true);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } else {
        throw error;
      }
    }
  }
}

/** 独立 registry：内置节点 + 可选自定义节点（不污染全局 registry）。 */
function makeRegistry(extra: readonly INodeDefinition[] = []): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of extra) reg.register(def);
  return reg;
}

function makeNode(reg: NodeRegistry, id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = reg.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeWeatherTool() {
  return {
    name: "demo.getWeather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: () => "上海晴，25 度",
  };
}

const reactScript: FakeScriptStep[] = [
  { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "上海" } } },
  { kind: "text", text: "上海晴，25 度" },
];

/** start → ai → end。 */
function buildWorkflow(reg: NodeRegistry, aiParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "ai-trace-wf",
    name: "AI 轨迹",
    version: "0.1.0",
    nodes: [makeNode(reg, "start", "start"), makeNode(reg, "ai", "ai", aiParams), makeNode(reg, "end", "end")],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ai", targetPortId: "in" },
      { id: "e2", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 失败节点：执行即抛错（node:error 日志触发点）。 */
const boomDef: INodeDefinition = {
  type: "boom",
  name: "boom",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [],
  async execute(_ctx: NodeExecutionContext): Promise<Record<string, unknown>> {
    throw new Error("boom exploded");
  },
};

function aiParams(invoke: boolean): Readonly<Record<string, unknown>> {
  return {
    model: { provider: "fake", model: "test", fakeScript: reactScript },
    inputMessages: "上海天气？",
    tools: ["demo.getWeather"],
    ...(invoke ? {} : { stream: true }),
  };
}

afterEach(() => {
  clearTools();
});

describe("AI 轨迹补全 + 执行日志补全（v0.2.4 T5）", () => {
  test("invoke 模式：进度事件落引擎日志 + data 结构化 + SQLite 带 nodeId", async () => {
    registerTool(makeWeatherTool());
    const reg = makeRegistry();
    const logStore = new ExecutionLogStore(nextDbPath("invoke"));
    const engine = new ExecutionEngine(buildWorkflow(reg, aiParams(true)), { registry: reg, logStore });
    try {
      const result = await engine.run();
      expect(result.status).toBe("success");
      const toolCall = engine.logs.find((e) => e.message === "工具调用: demo.getWeather");
      expect(toolCall?.data).toEqual({ kind: "tool_call", toolName: "demo.getWeather", args: { city: "上海" } });
      expect(engine.logs.some((e) => e.message === "工具结果: demo.getWeather")).toBe(true);
      expect(engine.logs.some((e) => e.message === "上海晴，25 度")).toBe(true);
      const llmMsg = engine.logs.find((e) => e.message === "上海晴，25 度");
      expect(llmMsg?.data).toEqual({ kind: "llm_message", message: "上海晴，25 度" });
      // SQLite 落库：AI 事件行带 nodeId=ai。
      await logStore.flush();
      const rows = await logStore.listByRun(engine.runId);
      const aiEvents = rows.filter((r) => r.message.startsWith("工具"));
      expect(aiEvents.length).toBe(2);
      for (const row of aiEvents) expect(row.nodeId).toBe("ai");
    } finally {
      await logStore.close();
    }
  });

  test("stream 模式：既有事件不受影响（回归）", async () => {
    registerTool(makeWeatherTool());
    const reg = makeRegistry();
    const engine = new ExecutionEngine(buildWorkflow(reg, aiParams(false)), { registry: reg });
    const result = await engine.run();
    expect(result.status).toBe("success");
    const messages = engine.logs.map((e) => e.message);
    expect(messages).toContain("工具调用: demo.getWeather");
    expect(messages).toContain("工具结果: demo.getWeather");
    expect(messages).toContain("上海晴，25 度");
  });

  test("执行日志：node:start/node:end 按拓扑序排列", async () => {
    registerTool(makeWeatherTool());
    const reg = makeRegistry();
    const engine = new ExecutionEngine(buildWorkflow(reg, aiParams(true)), { registry: reg });
    const result = await engine.run();
    expect(result.status).toBe("success");
    const nodeEvents = engine.logs.map((e) => e.message).filter((m) => m.startsWith("node:"));
    expect(nodeEvents).toEqual([
      "node:start start", "node:end start",
      "node:start ai", "node:end ai",
      "node:start end", "node:end end",
    ]);
  });

  test("失败节点：日志含 node:error", async () => {
    const reg = makeRegistry([boomDef]);
    const engine = new ExecutionEngine({
      id: "fail-wf", name: "fail", version: "0.1.0",
      nodes: [makeNode(reg, "start", "start"), makeNode(reg, "boom", "boom"), makeNode(reg, "end", "end")],
      edges: [{ id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" }],
    }, { registry: reg });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(engine.logs.some((e) => e.message.startsWith("node:error boom:"))).toBe(true);
  });

  test("挂起节点：日志含 node:waiting（humanTask，显式 humanTaskStore）", async () => {
    const reg = makeRegistry();
    const humanStore = new HumanTaskStore({ filePath: join(TEMP_BASE, "human-tasks.json") });
    const engine = new ExecutionEngine({
      id: "wait-wf", name: "wait", version: "0.1.0",
      nodes: [makeNode(reg, "start", "start"), makeNode(reg, "human", "humanTask", { title: "审批" }), makeNode(reg, "end", "end")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    }, { registry: reg, humanTaskStore: humanStore });
    const result = await engine.run();
    expect(result.status).toBe("waiting");
    expect(engine.logs.some((e) => e.message === "node:waiting human")).toBe(true);
  });

  test("断点暂停：日志含 node:waiting（paused）", async () => {
    registerTool(makeWeatherTool());
    const reg = makeRegistry();
    const dc = new DebugController();
    dc.setBreakpoints(["ai"]);
    const engine = new ExecutionEngine(buildWorkflow(reg, aiParams(true)), { registry: reg, debugController: dc });
    const result = await engine.run();
    expect(result.status).toBe("paused");
    expect(engine.logs.some((e) => e.message === "node:waiting ai")).toBe(true);
  });

  test("时间线：SQLite createdAt 单调不减（可恢复执行顺序）", async () => {
    registerTool(makeWeatherTool());
    const reg = makeRegistry();
    const logStore = new ExecutionLogStore(nextDbPath("timeline"));
    const engine = new ExecutionEngine(buildWorkflow(reg, aiParams(true)), { registry: reg, logStore });
    try {
      const result = await engine.run();
      expect(result.status).toBe("success");
      await logStore.flush();
      const rows = await logStore.listByRun(engine.runId);
      expect(rows.length).toBeGreaterThanOrEqual(9);
      let prevCreatedAt = 0;
      for (const row of rows) {
        const createdAt = row.createdAt ?? 0;
        expect(createdAt).toBeGreaterThanOrEqual(prevCreatedAt);
        prevCreatedAt = createdAt;
      }
    } finally {
      await logStore.close();
    }
  });
});
