// AI 端到端测试（Workflow 级）：start → ai → end 完整链路 + stream 场景。
// 与 ai-node.test.ts 的区别：走注册表完整名路径（registerTool → 节点 tools 引用 →
// resolveToolReferences → toLangChainTool → createAgent 注入），实测工具名映射结论：
// 注入名 = 注册完整名（"demo.getWeather"），fakeScript 的 tool_call.name 必须用完整名，
// 用短名（"get_weather"）会导致 langgraph 找不到工具、agent 执行失败。
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import type { HNFlowTool } from "../src/ai/types.js";
import { clearTools, registerTool } from "../src/ai/toolRegistry.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

/** 工具调用计数器：handler 实际被调用次数（工具名映射实测依据）。 */
interface ToolCalls {
  count: number;
}

/** 构造 demo 天气工具：handler 计数 + 返回固定天气字符串。 */
function makeWeatherTool(): { tool: HNFlowTool; calls: ToolCalls } {
  const calls: ToolCalls = { count: 0 };
  const tool: HNFlowTool = {
    name: "demo.getWeather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: (input) => {
      calls.count += 1;
      return `上海晴，25 度（${input["city"] ?? "未知城市"}）`;
    },
  };
  return { tool, calls };
}

/** 完整 ReAct 脚本：tool_call 用完整名（与注册表/注入名一致），再给最终回答。 */
const reactScript: FakeScriptStep[] = [
  { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "上海" } } },
  { kind: "text", text: "上海晴，25 度" },
];

/** 按注册表端口模板构造节点（与 ai-node.test.ts 一致）。 */
function makeNode(
  id: string,
  type: string,
  params: Readonly<Record<string, unknown>> = {},
): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → ai → end 三节点工作流：start.data 流出，ai.output 汇入 end.in。 */
function buildWorkflow(aiParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "ai-e2e",
    name: "AI 端到端",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("ai", "ai", aiParams),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ai", targetPortId: "in" },
      { id: "e2", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

afterEach(() => {
  clearTools();
});

describe("AI 端到端（Workflow 级）", () => {
  test("start → ai → end：工具 handler 被调用，endResult 读到 ai 输出", async () => {
    const { tool, calls } = makeWeatherTool();
    registerTool(tool);
    const workflow = buildWorkflow({
      model: { provider: "fake", model: "test", fakeScript: reactScript },
      inputMessages: [{ role: "user", content: "上海天气？" }],
      tools: ["demo.getWeather"],
    });
    const engine = new ExecutionEngine(workflow);
    const result = await engine.run();

    expect(result.status).toBe("success");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeStates["end"]).toBe("Success");
    // 工具名映射实测：fakeScript 用完整名 "demo.getWeather"，handler 恰好被调用 1 次；
    // 若用短名，langgraph 找不到工具 → agent 失败，此处必不通过。
    expect(calls.count).toBe(1);
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("上海晴，25 度");
    // end 经 in 端口 binding 写入 workflow:endResult。
    expect(engine.getWorkflowVariable("endResult")).toBe("上海晴，25 度");
    // 完整轨迹：human → ai(tool_call) → tool → ai(最终)。
    const messages = result.nodeOutputs["ai"]?.["messages"] as readonly {
      role: string;
      content: string;
    }[];
    expect(messages.map((m) => m.role)).toEqual(["human", "ai", "tool", "ai"]);
    expect(messages[2]?.content).toContain("上海晴，25 度");
  });

  test("stream=true：跑通且引擎日志收到工具调用/结果信息", async () => {
    const { tool } = makeWeatherTool();
    registerTool(tool);
    const workflow = buildWorkflow({
      model: { provider: "fake", model: "test", fakeScript: reactScript },
      inputMessages: "上海天气？",
      tools: ["demo.getWeather"],
      stream: true,
    });
    const engine = new ExecutionEngine(workflow);
    const result = await engine.run();

    expect(result.status).toBe("success");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("上海晴，25 度");
    // stream 进度事件经节点 logger 落入引擎内存日志。
    const logMessages = engine.logs.map((entry) => entry.message);
    expect(logMessages).toContain("工具调用: demo.getWeather");
    expect(logMessages).toContain("工具结果: demo.getWeather");
    expect(logMessages).toContain("上海晴，25 度");
  });
});
