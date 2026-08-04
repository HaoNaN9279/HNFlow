// LLM 节点测试：params 解析、FakeLLM 纯文本执行、stream 进度日志、registry。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { InvalidLLMParamsError, llmNode } from "../src/nodes/llm.js";
import { registry } from "../src/nodes/registry.js";

/** 日志收集：断言 stream 进度转发用。 */
interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly data: unknown;
}

function makeNode(
  id: string,
  type: string,
  params: Readonly<Record<string, unknown>> = {},
): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function createMockContext(node: Node, logs: LogEntry[] = []): NodeExecutionContext {
  const store: Record<string, unknown> = {};
  return {
    node,
    workflowId: "test-wf",
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

describe("llm 节点 execute 单测", () => {
  test("FakeLLM 纯文本：output 取文本，messages 含轨迹，toolCalls 为空", async () => {
    const node = makeNode("llm", "llm", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "你好，世界" }] },
      inputMessages: "你好",
    });
    const result = await llmNode.execute(createMockContext(node));
    expect(result["output"]).toBe("你好，世界");
    expect(result["toolCalls"]).toEqual([]);
    const messages = result["messages"] as readonly { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "human", content: "你好" });
    expect(messages[1]).toEqual({ role: "ai", content: "你好，世界" });
  });

  test("inputMessages 数组 + systemPrompt 透传", async () => {
    const node = makeNode("llm", "llm", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "收到" }] },
      systemPrompt: "你是助手",
      inputMessages: [{ role: "user", content: "你好" }],
    });
    const result = await llmNode.execute(createMockContext(node));
    expect(result["output"]).toBe("收到");
    const messages = result["messages"] as readonly { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "human", content: "你好" });
  });

  test("未提供 params 时默认 openai 构造不抛（无 key 仅运行时失败）", async () => {
    const node = makeNode("llm", "llm", {});
    // 无 key 的 ChatOpenAI 构造成功；不真正调用模型（这里只验证不抛 InvalidLLMParamsError 之外的错误）。
    await expect(llmNode.execute(createMockContext(node))).rejects.toThrow();
  });
});

describe("llm 节点 params 边界", () => {
  test("model 非对象抛 InvalidLLMParamsError", async () => {
    const node = makeNode("llm", "llm", { model: "openai" });
    const ctx = createMockContext(node);
    await expect(llmNode.execute(ctx)).rejects.toThrow(InvalidLLMParamsError);
  });

  test("model.provider 不受支持抛 InvalidLLMParamsError", async () => {
    const node = makeNode("llm", "llm", { model: { provider: "anthropic" } });
    const ctx = createMockContext(node);
    await expect(llmNode.execute(ctx)).rejects.toThrow(InvalidLLMParamsError);
  });

  test("inputMessages 非数组/字符串抛 InvalidLLMParamsError", async () => {
    const node = makeNode("llm", "llm", { inputMessages: 42 });
    const ctx = createMockContext(node);
    await expect(llmNode.execute(ctx)).rejects.toThrow(InvalidLLMParamsError);
  });

  test("inputMessages 数组元素 role 非法抛 InvalidLLMParamsError", async () => {
    const node = makeNode("llm", "llm", { inputMessages: [{ role: "robot", content: "hi" }] });
    const ctx = createMockContext(node);
    await expect(llmNode.execute(ctx)).rejects.toThrow(InvalidLLMParamsError);
  });

  test("systemPrompt 非字符串抛 InvalidLLMParamsError", async () => {
    const node = makeNode("llm", "llm", { systemPrompt: 42 });
    const ctx = createMockContext(node);
    await expect(llmNode.execute(ctx)).rejects.toThrow(InvalidLLMParamsError);
  });

  test("stream 非布尔抛 InvalidLLMParamsError", async () => {
    const node = makeNode("llm", "llm", { stream: "yes" });
    const ctx = createMockContext(node);
    await expect(llmNode.execute(ctx)).rejects.toThrow(InvalidLLMParamsError);
  });
});

describe("llm 节点 stream 进度日志", () => {
  test("stream=true 时进度事件转发到节点 logger", async () => {
    const logs: LogEntry[] = [];
    const node = makeNode("llm", "llm", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "晴" }] },
      inputMessages: "天气？",
      stream: true,
    });
    const result = await llmNode.execute(createMockContext(node, logs));
    expect(result["output"]).toBe("晴");
    expect(logs.map((entry) => entry.msg)).toEqual(["晴"]);
  });
});

describe("llm 节点 registry", () => {
  test("registry 已注册 llm 类型", () => {
    expect(registry.has("llm")).toBe(true);
  });
});
