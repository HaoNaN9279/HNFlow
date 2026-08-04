// T8 基础设施集成验收：端到端链路「saveWorkflow → Engine 执行（SQLite runState + executionLogs，persist=true）→ 挂起 → 恢复 → 查询日志」。
// 与 T6/T7 单点测试不同，这里用一条真实文件链路把存储（JSON 文件工作流 + SQLite runState/humanTask/log）串起来验证可复现、可审计。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { HumanTask } from "../src/human/types.js";
import { SqliteHumanTaskStore, SqliteRunStateStore } from "../src/db/stores.js";
import { ExecutionLogStore } from "../src/logs/ExecutionLogStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\infrastructure-test";

// 共享链路变量：一个 describe 内多个 test 顺序消费同一条链路（bun test 文件内默认串行）。
let fileCounter = 0;
let workflowFile = "";
let dbPath = "";
let logDbPath = "";
let runStore: SqliteRunStateStore | undefined;
let humanStore: SqliteHumanTaskStore | undefined;
let logStore: ExecutionLogStore | undefined;
let engine: ExecutionEngine | undefined;
let runId = "";
let taskId = "";

/** 按 registry 定义构造节点（端口与内置定义一致）。 */
function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → humanTask(审批) → log(info "done") → end 的审批工作流。 */
function makeApprovalWorkflow(): Workflow {
  return {
    id: "infra-wf",
    name: "infrastructure-approval",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", { title: "审批" }),
      makeNode("log", "log", { level: "info", message: "done" }),
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

/** 带重试的递归删除：Windows 上 sqlite 句柄释放有瞬态延迟（EBUSY），等待后重试，窗口放宽到 40×200ms。 */
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

describe("基础设施端到端链路", () => {
  beforeAll(async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    // 工作流文件 + runState/humanTask 共库 + 独立 log 库（与 T7 集成布局一致）。
    workflowFile = join(TEMP_BASE, `wf-${Date.now()}-${fileCounter++}.json`);
    dbPath = join(TEMP_BASE, `common-${Date.now()}-${fileCounter++}.db`);
    logDbPath = join(TEMP_BASE, `logs-${Date.now()}-${fileCounter++}.db`);
    runStore = new SqliteRunStateStore(dbPath);
    humanStore = new SqliteHumanTaskStore(dbPath);
    logStore = new ExecutionLogStore(logDbPath);
  });

  afterAll(async () => {
    // 先关库释放句柄，再递归清理临时目录（EBUSY 重试窗口 40×200ms）。
    await runStore?.close();
    await humanStore?.close();
    await logStore?.close();
    await rmRetry(TEMP_BASE);
  });

  test("saveWorkflow → loadWorkflow 往返一致", async () => {
    const workflow = makeApprovalWorkflow();
    await saveWorkflow(workflowFile, workflow);
    const loaded = await loadWorkflow(workflowFile);
    expect(loaded).toEqual(workflow);
    expect(loaded.nodes.some((node) => node.type === "humanTask")).toBe(true);
  });

  test("Engine 执行挂起：run 后 status waiting，runState 落库含 pendingTaskId", async () => {
    if (runStore === undefined || humanStore === undefined || logStore === undefined) {
      throw new Error("stores not initialized");
    }
    // 从文件加载工作流再执行，验证文件 → 引擎的真实链路。
    const workflow = await loadWorkflow(workflowFile);
    engine = new ExecutionEngine(workflow, {
      persist: true,
      runStateStore: runStore,
      humanTaskStore: humanStore,
      logStore,
    });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    expect(task.title).toBe("审批");
    runId = engine.runId;
    taskId = task.id;

    // 挂起快照已落库：status waiting + pendingTaskId 指向挂起任务。
    const snap = await runStore.getById(runId);
    expect(snap?.status).toBe("waiting");
    expect(snap?.pendingNodeId).toBe("human");
    expect(snap?.pendingTaskId).toBe(taskId);
  });

  test("resume 恢复：humanTask completed 且 runState success", async () => {
    if (engine === undefined || runStore === undefined || humanStore === undefined) {
      throw new Error("engine/stores not initialized");
    }
    const resumed = await engine.resume(taskId, "approved");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeStates["log"]).toBe("Success");

    const completed = await humanStore.getById(taskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("approved");
    expect((await runStore.getById(runId))?.status).toBe("success");
  });

  test("查询日志：log 节点日志 flush 后按 runId/workflowId 可查", async () => {
    if (engine === undefined || logStore === undefined) {
      throw new Error("engine/logStore not initialized");
    }
    await logStore.flush();

    const byRun = await logStore.listByRun(runId);
    expect(byRun.length).toBeGreaterThanOrEqual(1);
    const entry = byRun.find((row) => row.message === "done");
    if (entry === undefined) {
      throw new Error(`expected log entry "done" for run ${runId}`);
    }
    expect(entry.level).toBe("info");
    expect(entry.workflowId).toBe("infra-wf");
    expect(entry.nodeId).toBe("log");

    const byWorkflow = await logStore.listByWorkflow("infra-wf");
    expect(byWorkflow.length).toBeGreaterThanOrEqual(1);
  });
});
