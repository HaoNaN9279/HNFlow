// 模型解析与消息归一化测试。
import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  fromLangChainMessage,
  InvalidModelConfigError,
  resolveModel,
  toLangChainMessages,
  type ModelConfig,
} from "../src/ai/model.js";
import { FakeLLM } from "../src/ai/fake-llm.js";

describe("resolveModel", () => {
  test("openai provider 构造成功且保留模型名", () => {
    const model = resolveModel({ provider: "openai", apiKey: "test-key", model: "gpt-4o-mini" });
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect((model as ChatOpenAI).model).toBe("gpt-4o-mini");
  });

  test("openai 缺省模型为 gpt-4o", () => {
    const model = resolveModel({ provider: "openai", apiKey: "test-key" });
    expect((model as ChatOpenAI).model).toBe("gpt-4o");
  });

  test("openai 支持 baseURL 透传", () => {
    const model = resolveModel({
      provider: "openai",
      apiKey: "test-key",
      baseURL: "https://example.com/v1",
    });
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  test("fake provider 构造 FakeLLM（空脚本）", () => {
    const model = resolveModel({ provider: "fake" });
    expect(model).toBeInstanceOf(FakeLLM);
  });

  test("fake provider 带脚本可推进", async () => {
    const model = resolveModel({
      provider: "fake",
      fakeScript: [{ kind: "text", text: "你好" }],
    });
    const fake = model as FakeLLM;
    const res = await fake.invoke([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("你好");
  });

  test("非法 provider 抛 InvalidModelConfigError", () => {
    const bad = { provider: "anthropic" } as unknown as ModelConfig;
    expect(() => resolveModel(bad)).toThrow(InvalidModelConfigError);
  });
});

describe("toLangChainMessages", () => {
  test("按 role 映射为对应消息类", () => {
    const messages = toLangChainMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
      { role: "assistant", content: "ast" },
    ]);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[2]).toBeInstanceOf(AIMessage);
  });
});

describe("fromLangChainMessage", () => {
  test("提取文本与角色（string content）", () => {
    expect(fromLangChainMessage(new AIMessage("答案"))).toEqual({ role: "ai", content: "答案" });
    expect(fromLangChainMessage(new HumanMessage("问题"))).toEqual({
      role: "human",
      content: "问题",
    });
    expect(fromLangChainMessage(new SystemMessage("提示"))).toEqual({
      role: "system",
      content: "提示",
    });
  });

  test("content 为内容块数组时提取 text", () => {
    const message = new AIMessage([{ type: "text", text: "前" }, { type: "text", text: "后" }]);
    expect(fromLangChainMessage(message)).toEqual({ role: "ai", content: "前后" });
  });
});
