// FakeLLM 测试：脚本化推进、tool_calls 输出、createAgent 集成冒烟（驱动完整 ReAct 循环）。
import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createAgent } from "langchain";
import { FakeLLM, FakeScriptExhaustedError } from "../src/ai/fake-llm.js";

describe("FakeLLM 脚本化输出", () => {
  test("tool_call 步返回带 tool_calls 的 AIMessage", async () => {
    const llm = new FakeLLM({
      script: [{ kind: "tool_call", toolCall: { name: "my_tool", args: { query: "hi" } } }],
    });
    const res = await llm.invoke([{ role: "user", content: "hi" }]);
    expect(res).toBeInstanceOf(AIMessage);
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls?.[0]?.name).toBe("my_tool");
    expect(res.tool_calls?.[0]?.args).toEqual({ query: "hi" });
    expect(res.tool_calls?.[0]?.id).toBeDefined();
  });

  test("tool_call 步缺省 id 自动生成", async () => {
    const llm = new FakeLLM({
      script: [{ kind: "tool_call", toolCall: { name: "my_tool", args: {} } }],
    });
    const res = await llm.invoke([{ role: "user", content: "hi" }]);
    expect(res.tool_calls?.[0]?.id).toBe("call_0");
  });

  test("text 步返回纯文本 AIMessage", async () => {
    const llm = new FakeLLM({ script: [{ kind: "text", text: "最终答案" }] });
    const res = await llm.invoke([{ role: "user", content: "hi" }]);
    expect(res).toBeInstanceOf(AIMessage);
    expect(res.content).toBe("最终答案");
    expect(res.tool_calls ?? []).toHaveLength(0);
  });

  test("多次调用按脚本顺序推进，脚本用尽抛 FakeScriptExhaustedError", async () => {
    const llm = new FakeLLM({
      script: [
        { kind: "text", text: "一" },
        { kind: "text", text: "二" },
      ],
    });
    expect((await llm.invoke([{ role: "user", content: "a" }])).content).toBe("一");
    expect((await llm.invoke([{ role: "user", content: "b" }])).content).toBe("二");
    expect(llm.stepIndex).toBe(2);
    await expect(llm.invoke([{ role: "user", content: "c" }])).rejects.toBeInstanceOf(
      FakeScriptExhaustedError,
    );
  });

  test("delayMs 控制每次 _generate 的延迟", async () => {
    const llm = new FakeLLM({ script: [{ kind: "text", text: "慢" }], delayMs: 30 });
    const start = Date.now();
    await llm.invoke([{ role: "user", content: "a" }]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  test("bindTools 记录工具列表且不影响 createAgent 的工具校验", async () => {
    const llm = new FakeLLM({ script: [{ kind: "text", text: "ok" }] });
    const myTool = tool(
      ({ query }: { query: string }) => `结果: ${query}`,
      { name: "my_tool", description: "测试工具", schema: z.object({ query: z.string() }) },
    );
    llm.bindTools([myTool]);
    expect(llm.boundTools).toHaveLength(1);
    // 绑定后仍可直接 invoke（不受 createAgent 校验限制）。
    expect((await llm.invoke([{ role: "user", content: "a" }])).content).toBe("ok");
  });
});

describe("createAgent 集成冒烟", () => {
  test("脚本驱动完整 ReAct 循环：工具实际调用，最终返回 text 步内容", async () => {
    let toolCalls = 0;
    const myTool = tool(
      ({ query }: { query: string }) => {
        toolCalls += 1;
        return `工具结果: ${query}`;
      },
      {
        name: "my_tool",
        description: "测试工具",
        schema: z.object({ query: z.string() }),
      },
    );
    const llm = new FakeLLM({
      script: [
        { kind: "tool_call", toolCall: { name: "my_tool", args: { query: "hello" } } },
        { kind: "text", text: "最终回答" },
      ],
    });
    const agent = createAgent({ model: llm, tools: [myTool] });
    const result = await agent.invoke({ messages: [{ role: "user", content: "test" }] });
    const messages = result.messages;
    // 工具确被调用，且产生了 ToolMessage。
    expect(toolCalls).toBe(1);
    expect(messages.some((m) => m instanceof ToolMessage)).toBe(true);
    // 最终消息是 text 步内容（无 tool_calls → 循环终止）。
    const last = messages[messages.length - 1];
    expect(last).toBeInstanceOf(AIMessage);
    if (!(last instanceof AIMessage)) {
      throw new Error("expected last message to be AIMessage");
    }
    expect(last.content).toBe("最终回答");
    // FakeLLM 记录到了绑定工具。
    expect(llm.boundTools).toHaveLength(1);
    expect(llm.stepIndex).toBe(2);
  });
});
