// AIExecutor 接口类型契约冒烟：最小 stub 实现验证类型可用并跑通 execute。
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AIExecutor, AIExecutionRequest, AIExecutionResult } from "../src/ai/executor.js";
import { FakeLLM } from "../src/ai/fake-llm.js";
import type { HNFlowTool } from "../src/ai/types.js";

/** 最小 stub 实现：不真正调用模型，仅验证接口契约可被实现。 */
class StubExecutor implements AIExecutor {
  async execute(request: AIExecutionRequest): Promise<AIExecutionResult> {
    request.onProgress?.({ kind: "llm_message", message: "处理中" });
    return {
      output: "stub 输出",
      messages: request.inputMessages.map((m) => ({ role: m.role, content: m.content })),
      toolCalls: [{ name: "demo.ping", args: { query: "hi" } }],
    };
  }
}

describe("AIExecutor 接口", () => {
  test("stub 实现 execute 跑通并保留入参", async () => {
    const executor: AIExecutor = new StubExecutor();
    const model = new FakeLLM({ script: [] });
    const tool: HNFlowTool = {
      name: "demo.ping",
      description: "ping 工具",
      parameters: z.object({ query: z.string() }),
      handler: (input) => `pong: ${input["query"] ?? ""}`,
    };
    let progressEvents = 0;
    const result = await executor.execute({
      model,
      tools: [tool],
      inputMessages: [{ role: "user", content: "你好" }],
      onProgress: () => {
        progressEvents += 1;
      },
    });
    expect(result.output).toBe("stub 输出");
    expect(result.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(result.toolCalls).toEqual([{ name: "demo.ping", args: { query: "hi" } }]);
    expect(progressEvents).toBe(1);
  });

  test("类型契约：request 全字段可用", () => {
    const request: AIExecutionRequest = {
      model: new FakeLLM({ script: [] }),
      systemPrompt: "助手",
      tools: [],
      inputMessages: [],
      stream: true,
    };
    expect(request.systemPrompt).toBe("助手");
    expect(request.stream).toBe(true);
    expect(request.tools).toHaveLength(0);
  });
});
