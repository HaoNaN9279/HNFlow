// LangGraphExecutor 实现测试：invoke/stream 模式、进度事件、无工具、错误封装。
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AIExecutionError,
  LangGraphExecutor,
} from "../src/ai/langgraph-executor.js";
import { FakeScriptExhaustedError } from "../src/ai/fake-llm.js";
import { resolveModel } from "../src/ai/model.js";
import type { AIProgressEvent } from "../src/ai/executor.js";
import type { HNFlowTool } from "../src/ai/types.js";

/** 天气工具：同步 handler，返回带参数的回显文本。 */
function weatherTool(): HNFlowTool {
  return {
    name: "get_weather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: (input) => `天气: ${input["city"] ?? ""} 晴`,
  };
}

/** 完整 ReAct 脚本：先调 get_weather，再给最终回答。 */
const reactScript = [
  { kind: "tool_call", toolCall: { name: "get_weather", args: { city: "北京" } } },
  { kind: "text", text: "北京今天晴天。" },
] as const;

const executor = new LangGraphExecutor();

describe("LangGraphExecutor invoke 模式", () => {
  test("脚本驱动完整 ReAct：output/toolCalls/轨迹齐全", async () => {
    const model = resolveModel({ provider: "fake", model: "test", fakeScript: reactScript });
    const result = await executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
    });
    expect(result.output).toBe("北京今天晴天。");
    expect(result.toolCalls).toEqual([
      { name: "get_weather", args: { city: "北京" } },
    ]);
    // 轨迹：human → ai(tool_call) → tool → ai(最终)。
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai", "tool", "ai"]);
    expect(result.messages.at(-1)?.content).toBe("北京今天晴天。");
    expect(result.messages[2]?.content).toBe("天气: 北京 晴");
  });

  test("无 tools 请求：纯文本脚本直接返回，无工具调用", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "text", text: "直接回答" }],
    });
    const result = await executor.execute({
      model,
      tools: [],
      inputMessages: [{ role: "user", content: "hi" }],
    });
    expect(result.output).toBe("直接回答");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai"]);
  });

  test("systemPrompt 传入不报错且不影响结果（createAgent 内部注入，不写入轨迹）", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "text", text: "收到" }],
    });
    const result = await executor.execute({
      model,
      systemPrompt: "你是助手",
      tools: [],
      inputMessages: [{ role: "user", content: "hi" }],
    });
    expect(result.output).toBe("收到");
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai"]);
  });

  test("工具执行抛错不中断 agent：错误进 ToolMessage，最终仍返回", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [
        { kind: "tool_call", toolCall: { name: "get_weather", args: { city: "北京" } } },
        { kind: "text", text: "工具出错了，我总结一下" },
      ],
    });
    const boomTool: HNFlowTool = {
      name: "get_weather",
      description: "必炸工具",
      parameters: z.object({ city: z.string() }),
      handler: () => {
        throw new Error("工具内部错误");
      },
    };
    const result = await executor.execute({
      model,
      tools: [boomTool],
      inputMessages: [{ role: "user", content: "北京天气？" }],
    });
    expect(result.output).toBe("工具出错了，我总结一下");
    // 工具错误留在轨迹中，且 toolCalls 仍被汇总。
    expect(result.messages[2]?.content).toContain("工具内部错误");
    expect(result.toolCalls).toHaveLength(1);
  });
});

describe("LangGraphExecutor stream 模式", () => {
  test("onProgress 依次收到 tool_call → tool_result → llm_message", async () => {
    const model = resolveModel({ provider: "fake", model: "test", fakeScript: reactScript });
    const events: AIProgressEvent[] = [];
    const result = await executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
      stream: true,
      onProgress: (event) => {
        events.push(event);
      },
    });
    expect(result.output).toBe("北京今天晴天。");
    expect(result.toolCalls).toHaveLength(1);
    expect(events).toEqual([
      { kind: "tool_call", toolName: "get_weather", toolArgs: { city: "北京" } },
      { kind: "tool_result", toolName: "get_weather", toolResult: "天气: 北京 晴" },
      { kind: "llm_message", message: "北京今天晴天。" },
    ]);
  });

  test("onProgress 未提供时正常执行", async () => {
    const model = resolveModel({ provider: "fake", model: "test", fakeScript: reactScript });
    const result = await executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
      stream: true,
    });
    expect(result.output).toBe("北京今天晴天。");
    expect(result.messages).toHaveLength(4);
  });

  test("无 tools 的 stream：只有 llm_message", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "text", text: "流式直接回答" }],
    });
    const events: AIProgressEvent[] = [];
    const result = await executor.execute({
      model,
      tools: [],
      inputMessages: [{ role: "user", content: "hi" }],
      stream: true,
      onProgress: (event) => {
        events.push(event);
      },
    });
    expect(result.output).toBe("流式直接回答");
    expect(events).toEqual([{ kind: "llm_message", message: "流式直接回答" }]);
  });
});

describe("LangGraphExecutor 错误封装", () => {
  test("脚本用尽抛 AIExecutionError，cause 为 FakeScriptExhaustedError", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      // 只有一步 tool_call：工具执行后模型再次调用必然用尽。
      fakeScript: [{ kind: "tool_call", toolCall: { name: "get_weather", args: { city: "北京" } } }],
    });
    try {
      await executor.execute({
        model,
        tools: [weatherTool()],
        inputMessages: [{ role: "user", content: "北京天气？" }],
      });
      throw new Error("应已抛 AIExecutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(AIExecutionError);
      if (err instanceof AIExecutionError) {
        expect(err.cause).toBeInstanceOf(FakeScriptExhaustedError);
      }
    }
  });
});
