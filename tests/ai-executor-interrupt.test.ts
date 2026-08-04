// LangGraphExecutor AI 中断（工具审批）测试：中断触发、恢复 approve/reject、多轮中断、
// 无中断配置回归、checkpoint 落库、stream 模式中断。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { LangGraphExecutor } from "../src/ai/langgraph-executor.js";
import { AiInterruptRequiredError, type AIInterruptConfig } from "../src/ai/executor.js";
import { SqliteCheckpointSaver } from "../src/ai/checkpoint-saver.js";
import { resolveModel } from "../src/ai/model.js";
import type { AIProgressEvent } from "../src/ai/executor.js";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import type { HNFlowTool } from "../src/ai/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\ai-executor-interrupt-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  // Windows 上 sqlite 句柄释放有瞬态延迟，重试删除避免 EBUSY。
  await rmRetry(TEMP_BASE);
}, 30000);

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

const executor = new LangGraphExecutor();

/** 天气工具：命名空间前缀 "demo.getWeather"，同步 handler。 */
function weatherTool(): HNFlowTool {
  return {
    name: "demo.getWeather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: (input) => `天气: ${input["city"] ?? ""} 晴`,
  };
}

/** 搜索工具：命名空间前缀 "demo.search"。 */
function searchTool(): HNFlowTool {
  return {
    name: "demo.search",
    description: "搜索",
    parameters: z.object({ q: z.string() }),
    handler: (input) => `搜索: ${input["q"] ?? ""}`,
  };
}

/** 两个工具均需审批的中断配置。 */
function interruptConfig(): AIInterruptConfig {
  return {
    interruptOn: {
      "demo.getWeather": { allowedDecisions: ["approve", "reject"] },
      "demo.search": { allowedDecisions: ["approve", "reject"] },
    },
  };
}

/** 断言 promise 抛 AiInterruptRequiredError 并返回该错误。 */
async function catchInterrupt(promise: Promise<unknown>): Promise<AiInterruptRequiredError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AiInterruptRequiredError);
    return error as AiInterruptRequiredError;
  }
  throw new Error("应已抛 AiInterruptRequiredError");
}

describe("LangGraphExecutor AI 中断", () => {
  test("中断触发：interrupt 配置 + 工具调用 → 抛 AiInterruptRequiredError（value/threadId/checkpointId/description 齐全）", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } }],
    });
    const err = await catchInterrupt(executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath: nextDbPath("trigger") },
    }));
    expect(err.threadId).not.toBe("");
    expect(err.checkpointId).not.toBe("");
    expect(err.description).toContain("demo.getWeather");
    const value = err.interruptValue as { actionRequests?: { name: string; args: Record<string, unknown> }[] };
    expect(value.actionRequests?.[0]?.name).toBe("demo.getWeather");
    expect(value.actionRequests?.[0]?.args).toEqual({ city: "北京" });
  });

  test("中断触发缺 checkpointDb：抛 AIExecutionError 提示", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } }],
    });
    await expect(
      executor.execute({
        model,
        tools: [weatherTool()],
        inputMessages: [{ role: "user", content: "北京天气？" }],
        interrupt: interruptConfig(),
      }),
    ).rejects.toThrow("checkpointDb");
  });

  test("恢复 approve：resume 后工具执行，结果含 ToolMessage 与最终回答", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [
        { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } },
        { kind: "text", text: "北京晴天。" },
      ],
    });
    const dbPath = nextDbPath("approve");
    const err = await catchInterrupt(executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    }));
    const result = await executor.resume({
      model,
      tools: [weatherTool()],
      threadId: err.threadId,
      checkpointId: err.checkpointId,
      decisions: [{ type: "approve" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    });
    expect(result.output).toBe("北京晴天。");
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai", "tool", "ai"]);
    expect(result.messages[2]?.content).toBe("天气: 北京 晴");
  });

  test("恢复 reject：agent 收到含拒绝原因的 ToolMessage，模型重新回答", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [
        { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } },
        { kind: "text", text: "天气查询被拒绝，我无法回答。" },
      ],
    });
    const dbPath = nextDbPath("reject");
    const err = await catchInterrupt(executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    }));
    const result = await executor.resume({
      model,
      tools: [weatherTool()],
      threadId: err.threadId,
      checkpointId: err.checkpointId,
      decisions: [{ type: "reject", message: "拒绝调用" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    });
    expect(result.output).toBe("天气查询被拒绝，我无法回答。");
    // 轨迹：human → ai(tool_call) → tool(拒绝原因) → ai(最终)。
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai", "tool", "ai"]);
    expect(result.messages[2]?.content).toBe("拒绝调用");
  });

  test("多轮中断：两次中断 checkpointId 不同，逐次 approve 后完成", async () => {
    const script: readonly FakeScriptStep[] = [
      { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } },
      { kind: "tool_call", toolCall: { name: "demo.search", args: { q: "HNFlow" } } },
      { kind: "text", text: "完成。" },
    ];
    const model = resolveModel({ provider: "fake", model: "test", fakeScript: script });
    const dbPath = nextDbPath("multi");
    const err1 = await catchInterrupt(executor.execute({
      model,
      tools: [weatherTool(), searchTool()],
      inputMessages: [{ role: "user", content: "查天气再搜索" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    }));
    expect(err1.interruptValue).toBeDefined();

    const err2 = await catchInterrupt(executor.resume({
      model,
      tools: [weatherTool(), searchTool()],
      threadId: err1.threadId,
      checkpointId: err1.checkpointId,
      decisions: [{ type: "approve" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    }));
    expect(err2.checkpointId).not.toBe(err1.checkpointId);
    const value2 = err2.interruptValue as { actionRequests?: { name: string }[] };
    expect(value2.actionRequests?.[0]?.name).toBe("demo.search");

    const result = await executor.resume({
      model,
      tools: [weatherTool(), searchTool()],
      threadId: err2.threadId,
      checkpointId: err2.checkpointId,
      decisions: [{ type: "approve" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    });
    expect(result.output).toBe("完成。");
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai", "tool", "ai", "tool", "ai"]);
  });

  test("无 interrupt 配置回归：与 v0.2.0 行为一致（工具直接执行）", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [
        { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } },
        { kind: "text", text: "北京晴天。" },
      ],
    });
    const result = await executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
    });
    expect(result.output).toBe("北京晴天。");
    expect(result.toolCalls).toEqual([{ name: "demo.getWeather", args: { city: "北京" } }]);
    expect(result.messages.map((m) => m.role)).toEqual(["human", "ai", "tool", "ai"]);
  });

  test("checkpoint 落库：中断后新 saver 实例同 dbPath 可读 checkpoint_id", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } }],
    });
    const dbPath = nextDbPath("persist");
    const err = await catchInterrupt(executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "北京天气？" }],
      interrupt: interruptConfig(),
      checkpointDb: { dbPath },
    }));
    const saver = new SqliteCheckpointSaver(dbPath);
    try {
      const tuple = await saver.getTuple({ configurable: { thread_id: err.threadId } });
      expect(tuple?.config.configurable?.checkpoint_id).toBe(err.checkpointId);
    } finally {
      await saver.close();
    }
  });

  test("stream 模式中断：先报 tool_call 进度，中断 chunk 抛 AiInterruptRequiredError", async () => {
    const model = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "上海" } } }],
    });
    const events: AIProgressEvent[] = [];
    const err = await catchInterrupt(executor.execute({
      model,
      tools: [weatherTool()],
      inputMessages: [{ role: "user", content: "上海天气？" }],
      stream: true,
      onProgress: (event) => {
        events.push(event);
      },
      interrupt: interruptConfig(),
      checkpointDb: { dbPath: nextDbPath("stream") },
    }));
    expect(err.description).toContain("demo.getWeather");
    expect(events).toEqual([
      { kind: "tool_call", toolName: "demo.getWeather", toolArgs: { city: "上海" } },
    ]);
  });
});
