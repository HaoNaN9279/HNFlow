// T7 日志接入集成测试：Engine recordLog → ExecutionLogStore 持久化全链路。
// 场景 A：成功流日志转发 + runState persist；场景 B：挂起→恢复后日志落库；
// 场景 C：失败流 error 日志落库；场景 D：Engine.ts 行数约束（<440）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { HumanTask } from "../src/human/types.js";
import { SqliteHumanTaskStore, SqliteRunStateStore } from "../src/db/stores.js";
import { ExecutionLogStore } from "../src/logs/ExecutionLogStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\logs-integration-test";

let fileCounter = 0;

/** 生成唯一 sqlite 文件库路径。 */
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  // Windows 上 sqlite 释放文件句柄有瞬态延迟，重试删除避免 EBUSY。
  await rmRetry(TEMP_BASE);
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 按 registry 定义构造节点（端口与内置定义一致）。 */
function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → log(level, message) → end 的最小日志工作流。 */
function makeLogWorkflow(id: string, level: "info" | "warn" | "error", message: string): Workflow {
  return {
    id,
    name: `log-${level}`,
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("log", "log", { level, message }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "log", targetPortId: "in" },
      { id: "e2", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** start → humanTask(审批) → log(info, message) → end 的挂起工作流。 */
function makeApprovalWorkflow(message: string): Workflow {
  return {
    id: "logs-integration-approval",
    name: "logs-approval",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", { title: "审批" }),
      makeNode("log", "log", { level: "info", message }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "log", targetPortId: "in" },
      { id: "e3", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 收窄 waiting 结果并返回任务。 */
function expectWaiting(result: { status: string; waitingTask?: HumanTask }): HumanTask {
  if (result.status !== "waiting") {
    throw new Error(`expected waiting status, got: ${result.status}`);
  }
  const task = result.waitingTask;
  if (task === undefined) {
    throw new Error("expected waitingTask in result");
  }
  return task;
}

describe("场景 A 成功流日志转发", () => {
  test("run success：日志 flush 后按 runId 可查，runState persist 生效", async () => {
    // runState 与 humanTask 共库（三张表同文件），logStore 独立文件。
    const dbPath = nextDbPath("a-common");
    const runStore = new SqliteRunStateStore(dbPath);
    const humanStore = new SqliteHumanTaskStore(dbPath);
    const logStore = new ExecutionLogStore(nextDbPath("a-log"));
    try {
      const engine = new ExecutionEngine(makeLogWorkflow("logs-wf-a", "info", "hello"), {
        persist: true,
        runStateStore: runStore,
        humanTaskStore: humanStore,
        logStore,
      });

      const result = await engine.run();
      expect(result.status).toBe("success");

      // 引擎转发入缓冲 → flush 后落库可查。
      await logStore.flush();
      const rows = await logStore.listByRun(engine.runId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const entry = rows.find((row) => row.message === "hello");
      if (entry === undefined) {
        throw new Error(`expected log entry "hello" for run ${engine.runId}`);
      }
      expect(entry.level).toBe("info");
      expect(entry.workflowId).toBe("logs-wf-a");
      expect(entry.nodeId).toBe("log");

      // persist 生效：runState 可查且最终 success。
      const runState = await runStore.getById(engine.runId);
      expect(runState?.status).toBe("success");
      expect(runState?.workflowId).toBe("logs-wf-a");
    } finally {
      await runStore.close();
      await humanStore.close();
      await logStore.close();
    }
  });
});

describe("场景 B 挂起→恢复日志落库", () => {
  test("run waiting → resume success：恢复后 log 节点日志落库，runState 最终 success", async () => {
    const dbPath = nextDbPath("b-common");
    const runStore = new SqliteRunStateStore(dbPath);
    const humanStore = new SqliteHumanTaskStore(dbPath);
    const logStore = new ExecutionLogStore(nextDbPath("b-log"));
    try {
      const engine = new ExecutionEngine(makeApprovalWorkflow("after"), {
        persist: true,
        runStateStore: runStore,
        humanTaskStore: humanStore,
        logStore,
      });

      const result = await engine.run();
      expect(result.status).toBe("waiting");
      const task = expectWaiting(result);
      expect(task.title).toBe("审批");
      // 挂起快照已落库。
      expect((await runStore.getById(engine.runId))?.status).toBe("waiting");

      const resumed = await engine.resume(task.id, "ok");
      expect(resumed.status).toBe("success");
      expect(resumed.nodeStates["log"]).toBe("Success");

      // 恢复执行产生的 log 节点日志 → flush 后落库。
      await logStore.flush();
      const rows = await logStore.listByRun(engine.runId);
      const after = rows.find((row) => row.message === "after");
      if (after === undefined) {
        throw new Error(`expected log entry "after" for run ${engine.runId}`);
      }
      expect(after.level).toBe("info");
      expect(after.nodeId).toBe("log");
      expect(after.workflowId).toBe("logs-integration-approval");

      expect((await runStore.getById(engine.runId))?.status).toBe("success");
      expect((await humanStore.getById(task.id))?.status).toBe("completed");
    } finally {
      await runStore.close();
      await humanStore.close();
      await logStore.close();
    }
  });
});

describe("场景 C 失败流 error 日志落库", () => {
  test("run failed：log(error) 的 error 日志 flush 后可查", async () => {
    const dbPath = nextDbPath("c-common");
    const runStore = new SqliteRunStateStore(dbPath);
    const humanStore = new SqliteHumanTaskStore(dbPath);
    const logStore = new ExecutionLogStore(nextDbPath("c-log"));
    try {
      // log 节点 error 级别只记录不抛错；为构造 failed 结果，在 log 之后追加 fallback=ai 的 humanTask 触发失败。
      const workflow: Workflow = {
        id: "logs-wf-c",
        name: "logs-failure",
        version: "0.1.0",
        nodes: [
          makeNode("start", "start"),
          makeNode("log", "log", { level: "error", message: "boom" }),
          makeNode("human", "humanTask", { title: "审批", fallback: "ai" }),
          makeNode("end", "end"),
        ],
        edges: [
          { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "log", targetPortId: "in" },
          { id: "e2", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "human", targetPortId: "in" },
          { id: "e3", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
        ],
      };
      const engine = new ExecutionEngine(workflow, {
        persist: true,
        runStateStore: runStore,
        humanTaskStore: humanStore,
        logStore,
      });

      const result = await engine.run();
      expect(result.status).toBe("failed");
      expect(result.nodeStates["human"]).toBe("Failed");

      // 失败前 log 节点已执行：error 日志入缓冲 → flush 后落库。
      await logStore.flush();
      const rows = await logStore.listByRun(engine.runId);
      const boom = rows.find((row) => row.message === "boom");
      if (boom === undefined) {
        throw new Error(`expected log entry "boom" for run ${engine.runId}`);
      }
      expect(boom.level).toBe("error");
      expect(boom.workflowId).toBe("logs-wf-c");
      expect(boom.nodeId).toBe("log");

      expect((await runStore.getById(engine.runId))?.status).toBe("failed");
    } finally {
      await runStore.close();
      await humanStore.close();
      await logStore.close();
    }
  });
});

describe("场景 D Engine.ts 行数约束", () => {
  test("src/execution/Engine.ts 行数 < 440", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "execution", "Engine.ts"), "utf8");
    const lineCount = source.split("\n").length;
    expect(lineCount).toBeLessThan(440);
  });
});
