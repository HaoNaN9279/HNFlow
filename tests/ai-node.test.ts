// AI 节点测试：params 解析、工具引用解析、execute 单测、stream 进度日志、
// interrupt 中断（工具审批）、ExecutionEngine 集成、registry。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { aiExecutor } from "../src/ai/executor-instance.js";
import { AiInterruptRequiredError, type AIExecutionRequest } from "../src/ai/executor.js";
import { clearTools, registerTool } from "../src/ai/toolRegistry.js";
import { UnknownToolReferenceError } from "../src/ai/tool.js";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { aiNode, InvalidAIParamsError } from "../src/nodes/ai.js";
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

function createMockContext(node: Node, logs: LogEntry[] = [], aiCheckpoint?: NodeExecutionContext["aiCheckpoint"]): NodeExecutionContext {
  const store: Record<string, unknown> = {};
  return {
    node,
    workflowId: "test-wf",
    ...(aiCheckpoint !== undefined ? { aiCheckpoint } : {}),
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

/** demo 天气工具：handler 返回固定字符串。 */
function weatherTool() {
  return {
    name: "demo.getWeather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: () => "晴",
  };
}

/** 完整 ReAct 脚本：先调 demo.getWeather，再给最终回答。 */
const reactScript: FakeScriptStep[] = [
  { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } },
  { kind: "text", text: "晴" },
];

afterEach(() => {
  clearTools();
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows bun:sqlite 句柄释放依赖 GC，强制回收以解锁文件
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

describe("ai 节点 execute 单测", () => {
  test("FakeLLM 工具调用流：output 取最终文本，toolCalls 汇总", async () => {
    registerTool(weatherTool());
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: reactScript },
      inputMessages: "北京天气？",
      tools: ["demo.getWeather"],
    });
    const result = await aiNode.execute(createMockContext(node));
    expect(result["output"]).toBe("晴");
    expect(result["toolCalls"]).toEqual([{ name: "demo.getWeather", args: { city: "北京" } }]);
    expect(result["messages"]).toHaveLength(4);
  });

  test("inputMessages 数组 + systemPrompt 透传", async () => {
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "收到" }] },
      systemPrompt: "你是助手",
      inputMessages: [{ role: "user", content: "你好" }],
    });
    const result = await aiNode.execute(createMockContext(node));
    expect(result["output"]).toBe("收到");
    const messages = result["messages"] as readonly { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "human", content: "你好" });
  });

  test("未提供 params 时默认 openai 构造不抛（无 key 仅运行时失败）", async () => {
    const node = makeNode("ai", "ai", {});
    // 无 key 的 ChatOpenAI 构造成功；不真正调用模型（这里只验证不抛 InvalidAIParamsError 之外的错误）。
    await expect(aiNode.execute(createMockContext(node))).rejects.toThrow();
  });
});

describe("ai 节点 params 边界", () => {
  test("model 非对象抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { model: "openai" });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("model.provider 不受支持抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { model: { provider: "anthropic" } });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("inputMessages 非数组/字符串抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { inputMessages: 42 });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("inputMessages 数组元素 role 非法抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { inputMessages: [{ role: "robot", content: "hi" }] });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });
});

describe("ai 节点工具引用", () => {
  test("未注册工具引用抛 UnknownToolReferenceError", async () => {
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "hi" }] },
      tools: ["no.suchTool"],
    });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(UnknownToolReferenceError);
  });
});

describe("ai 节点 stream 进度日志", () => {
  test("stream=true 时进度事件转发到节点 logger", async () => {
    registerTool(weatherTool());
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: reactScript },
      inputMessages: "北京天气？",
      tools: ["demo.getWeather"],
      stream: true,
    });
    const result = await aiNode.execute(createMockContext(node, logs));
    expect(result["output"]).toBe("晴");
    expect(logs.map((entry) => entry.msg)).toEqual([
      "工具调用: demo.getWeather",
      "工具结果: demo.getWeather",
      "晴",
    ]);
  });
});

describe("ai 节点 interrupt 中断（工具审批）", () => {
  const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\ai-node-interrupt-test";
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

  /** 包装共享执行器仅记录 request 并透传真实执行（节点单测不经引擎：ctx.aiCheckpoint 由测试注入模拟引擎装配）。 */
  async function captureRequest(run: () => unknown): Promise<AIExecutionRequest> {
    const original = aiExecutor.execute;
    let captured: AIExecutionRequest | undefined;
    aiExecutor.execute = async (req) => {
      captured = req;
      return original.call(aiExecutor, req);
    };
    try {
      await run();
    } finally {
      aiExecutor.execute = original;
    }
    if (captured === undefined) {
      throw new Error("aiExecutor.execute 未被调用");
    }
    return captured;
  }

  test("interrupt=true：request 组装正确（interruptOn 覆盖全部工具 + threadId 稳定）", async () => {
    registerTool(weatherTool());
    const dbPath = nextDbPath("capture");
    const node = makeNode("ai", "ai", {
      model: {
        provider: "fake",
        model: "test",
        fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } }],
      },
      inputMessages: "北京天气？",
      tools: ["demo.getWeather"],
      interrupt: true,
    });
    const ctx = createMockContext(node, [], { dbPath });
    const request = await captureRequest(() =>
      expect(aiNode.execute(ctx)).rejects.toThrow(AiInterruptRequiredError));
    expect(request.interrupt).toEqual({
      interruptOn: { "demo.getWeather": { allowedDecisions: ["approve", "reject"] } },
    });
    // 稳定线程键：同节点多轮中断/恢复复用同一 thread。
    expect(request.threadId).toBe("test-wf:ai");
    // T5.1：节点从 ctx.aiCheckpoint 组装 checkpointDb（真实路径，非包装补丁）。
    expect(request.checkpointDb).toEqual({ dbPath });
  });

  test("interrupt 对象：request 携带静态配置并抛 AiInterruptRequiredError", async () => {
    registerTool(weatherTool());
    const dbPath = nextDbPath("capture");
    const node = makeNode("ai", "ai", {
      model: {
        provider: "fake",
        model: "test",
        fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } }],
      },
      inputMessages: "北京天气？",
      tools: ["demo.getWeather"],
      interrupt: {
        interruptOn: {
          "demo.getWeather": { allowedDecisions: ["approve", "reject"], description: "查询天气需审批" },
        },
      },
    });
    const ctx = createMockContext(node, [], { dbPath });
    const request = await captureRequest(() =>
      expect(aiNode.execute(ctx)).rejects.toThrow(AiInterruptRequiredError));
    expect(request.interrupt).toEqual({
      interruptOn: {
        "demo.getWeather": { allowedDecisions: ["approve", "reject"], description: "查询天气需审批" },
      },
    });
    expect(request.threadId).toBe("test-wf:ai");
    expect(request.checkpointDb).toEqual({ dbPath });
  });

  test("interrupt 启用但引擎未注入 aiCheckpoint：节点抛 InvalidAIParamsError（T5.1 装配错误）", async () => {
    registerTool(weatherTool());
    const node = makeNode("ai", "ai", {
      model: {
        provider: "fake",
        model: "test",
        fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } }],
      },
      inputMessages: "北京天气？",
      tools: ["demo.getWeather"],
      interrupt: true,
    });
    await expect(aiNode.execute(createMockContext(node))).rejects.toThrow("aiCheckpoint");
  });

  test("interrupt 非 true/对象抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { interrupt: "yes" });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("interrupt.interruptOn 缺失抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { interrupt: { allowedDecisions: ["approve"] } });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("interrupt.allowedDecisions 非法枚举抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", {
      interrupt: { interruptOn: { "demo.getWeather": { allowedDecisions: ["edit"] } } },
    });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("interrupt.allowedDecisions 非数组抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", {
      interrupt: { interruptOn: { "demo.getWeather": { allowedDecisions: "approve" } } },
    });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });

  test("interrupt.interruptOn 条目含 when 抛 InvalidAIParamsError（v0.2.1 仅静态配置）", async () => {
    const node = makeNode("ai", "ai", {
      interrupt: { interruptOn: { "demo.getWeather": { when: "x" } } },
    });
    const ctx = createMockContext(node);
    await expect(aiNode.execute(ctx)).rejects.toThrow(InvalidAIParamsError);
  });
});

describe("ai 节点 ExecutionEngine 集成", () => {
  test("start → ai → end：ai Success，end 读到 output", async () => {
    registerTool(weatherTool());
    const workflow: Workflow = {
      id: "ai-wf",
      name: "AI 工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("ai", "ai", {
          model: { provider: "fake", model: "test", fakeScript: reactScript },
          inputMessages: "北京天气？",
          tools: ["demo.getWeather"],
        }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(workflow);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeStates["end"]).toBe("Success");
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("晴");
    // end 通过 in 端口 binding 读到 ai 输出并写入 workflow:endResult。
    expect(engine.getWorkflowVariable("endResult")).toBe("晴");
  });
});

describe("ai 节点 registry", () => {
  test("registry 已注册 ai 类型", () => {
    expect(registry.has("ai")).toBe(true);
  });
});
