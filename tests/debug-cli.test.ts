// debug 子命令 CLI 测试（v0.2.4 T6）：直接调 main() 验证输出与退出码；
// RunState 预写 JSON（paused/contextSnapshot/分支快照），execution_logs 用 ExecutionLogStore 预写 SQLite。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli/index.js";
import { ExecutionLogStore } from "../src/logs/ExecutionLogStore.js";
import type { ExecutionLogEntry } from "../src/logs/types.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\debug-cli-test";
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

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= retries) throw error;
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EBUSY") throw error;
      Bun.gc(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** 构造 RunState：空工作流 + 可覆盖 contextSnapshot（debug CLI 只读 runId/status/snapshot）。 */
function makeRunState(runId: string, status: RunState["status"], contextSnapshot: RunState["contextSnapshot"]): RunState {
  return {
    runId, workflowId: "debug-wf", status, contextSnapshot, nodeStates: {}, nodeOutputs: {},
    workflow: { id: "debug-wf", name: "调试工作流", version: "0.1.0", nodes: [], edges: [], globalVariables: {} },
    updatedAt: 1700000000000,
  };
}

const emptyCtx = { global: {}, workflow: {}, node: {} };

async function writeRunStates(storePath: string, runs: readonly RunState[]): Promise<void> {
  await writeFile(storePath, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
}

async function writeLogs(dbPath: string, entries: readonly ExecutionLogEntry[]): Promise<void> {
  const store = new ExecutionLogStore(dbPath);
  try {
    for (const entry of entries) store.append(entry);
    await store.flush();
  } finally {
    await store.close();
  }
}

let stdout = "";
let stderr = "";
let code = -1;

async function runCli(argv: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return main(argv);
}

const originalLog = console.log;
const originalError = console.error;
const originalInfo = console.info;

beforeEach(() => {
  stdout = "";
  stderr = "";
  const log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.log = log;
  console.info = log;
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.info = originalInfo;
});

describe("debug runs", () => {
  test("列表：输出 runId 与 paused 状态（v0.2.4 新状态可显示）", async () => {
    const storePath = join(TEMP_BASE, "debug-runs.json");
    await writeRunStates(storePath, [
      makeRunState("run-ok", "success", emptyCtx),
      makeRunState("run-pause", "paused", emptyCtx),
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "runs", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("run-ok");
    expect(stdout).toContain("paused");
  });

  test("--status paused：只列 paused 运行", async () => {
    const storePath = join(TEMP_BASE, "debug-runs-filter.json");
    await writeRunStates(storePath, [
      makeRunState("run-ok", "success", emptyCtx),
      makeRunState("run-pause", "paused", emptyCtx),
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "runs", "--status", "paused", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("run-pause");
    expect(stdout).not.toContain("run-ok");
  });

  test("--status 非法值：stderr 错误 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "debug", "runs", "--status", "bogus"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("非法状态");
  });
});

describe("debug context", () => {
  test("渲染 global/workflow 作用域", async () => {
    const storePath = join(TEMP_BASE, "debug-ctx.json");
    await writeRunStates(storePath, [
      makeRunState("run-ctx", "paused", { global: { name: "张三" }, workflow: { x: 42 }, node: {} }),
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "context", "run-ctx", "--store", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("status: paused");
    expect(stdout).toContain("global:");
    expect(stdout).toContain('name: "张三"');
    expect(stdout).toContain("workflow:");
    expect(stdout).toContain("x: 42");
  });

  test("传 nodeId：渲染 node 作用域 + branch 分支快照", async () => {
    const storePath = join(TEMP_BASE, "debug-ctx-node.json");
    await writeRunStates(storePath, [
      makeRunState("run-node", "paused", {
        global: {}, workflow: {},
        node: { "node:loop": { "branch:0": { loopIndex: 0, loopItem: 10, loopCount: 3 } } },
      }),
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "context", "run-node", "loop", "--store", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("node:loop:");
    expect(stdout).toContain("branch:0");
    expect(stdout).toContain("loopIndex");
  });

  test("未找到 run：stderr 错误 + 非 0 退出码", async () => {
    const storePath = join(TEMP_BASE, "debug-ctx-missing.json");
    code = await runCli(["bun", "src/cli/index.ts", "debug", "context", "no-run", "--store", storePath]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("未找到运行记录");
  });
});

describe("debug trace", () => {
  test("渲染 AI 事件时间线（过滤非 AI 日志）", async () => {
    const dbPath = nextDbPath("trace");
    await writeLogs(dbPath, [
      { runId: "run-t", workflowId: "wf", nodeId: "ai", level: "info", message: "node:start ai", createdAt: 0 },
      { runId: "run-t", workflowId: "wf", nodeId: "ai", level: "info", message: "工具调用: demo.getWeather", data: { kind: "tool_call", toolName: "demo.getWeather", args: { city: "上海" } }, createdAt: 1 },
      { runId: "run-t", workflowId: "wf", nodeId: "ai", level: "info", message: "工具结果: demo.getWeather", data: { kind: "tool_result", toolName: "demo.getWeather", result: "上海晴，25 度" }, createdAt: 2 },
      { runId: "run-t", workflowId: "wf", nodeId: "ai", level: "info", message: "上海晴，25 度", data: { kind: "llm_message", message: "上海晴，25 度" }, createdAt: 3 },
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "trace", "run-t", "ai", dbPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("tool_call");
    expect(stdout).toContain("demo.getWeather");
    expect(stdout).toContain("tool_result");
    expect(stdout).toContain("llm_message");
    expect(stdout).toContain("上海晴，25 度");
    expect(stdout).not.toContain("node:start");
  });
});

describe("debug logs", () => {
  test("渲染节点日志序列（node: 前缀，按 createdAt 排序）", async () => {
    const dbPath = nextDbPath("logs");
    await writeLogs(dbPath, [
      { runId: "run-l", workflowId: "wf", nodeId: "ai", level: "info", message: "node:start ai", createdAt: 0 },
      { runId: "run-l", workflowId: "wf", nodeId: "ai", level: "info", message: "node:waiting ai", data: { status: "Paused" }, createdAt: 1 },
      { runId: "run-l", workflowId: "wf", nodeId: "ai", level: "info", message: "node:end ai", createdAt: 2 },
      // 非节点日志（AI 事件）不应出现在节点日志视图。
      { runId: "run-l", workflowId: "wf", nodeId: "ai", level: "info", message: "工具调用: demo.getWeather", data: { kind: "tool_call", toolName: "demo.getWeather", args: {} }, createdAt: 3 },
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "logs", "run-l", "ai", dbPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("node:start ai");
    expect(stdout).toContain("node:waiting ai");
    expect(stdout).toContain("node:end ai");
    expect(stdout).not.toContain("工具调用");
  });

  test("--level error：只列 error 级节点日志", async () => {
    const dbPath = nextDbPath("logs-error");
    await writeLogs(dbPath, [
      { runId: "run-e", workflowId: "wf", nodeId: "boom", level: "error", message: "node:error boom: boom exploded", createdAt: 0 },
      { runId: "run-e", workflowId: "wf", nodeId: "boom", level: "info", message: "node:start boom", createdAt: 1 },
    ]);
    code = await runCli(["bun", "src/cli/index.ts", "debug", "logs", "run-e", "boom", "--level", "error", dbPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("node:error boom");
    expect(stdout).not.toContain("node:start boom");
  });
});

describe("debug 非法参数", () => {
  test("缺/未知子命令：stderr 提示 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "debug"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少 debug 子命令");
    code = await runCli(["bun", "src/cli/index.ts", "debug", "bogus"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("未知 debug 子命令");
  });

  test("context 缺 runId：stderr 错误 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "debug", "context"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少 runId");
  });

  test("trace 缺 nodeId：stderr 错误 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "debug", "trace", "run-x"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少 runId 或 nodeId");
  });

  test("logs 缺 runId：stderr 错误 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "debug", "logs"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少 runId");
  });

  test("logs --level 非法值：stderr 错误 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "debug", "logs", "run-x", "--level", "verbose"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("非法级别");
  });
});
