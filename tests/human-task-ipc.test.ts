// 人工任务 IPC 提交链路闭环测试（v0.9.3）：等价 handlers.ts 的 task:submit/task:skip/task:reopen 核心逻辑。
// 手工构造 waiting 断点快照 + pending 任务文件 → resumeTask/skipTask 续跑至终态落盘；reopen 生效。
// 不依赖 electron（resume.ts / HumanTaskStore / RunStateStore 均无 electron 依赖），bun test 直跑。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";
import { resumeTask, skipTask } from "../src/execution/resume.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → humanTask → log → end 的挂起工作流（IPC 提交链路场景）。 */
function approvalWorkflow(): Workflow {
  return {
    id: "ipc-approval-wf",
    name: "ipc-approval",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", { title: "审批" }),
      makeNode("log", "log", { level: "info", message: "after approval" }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "log", targetPortId: "in" },
      { id: "e3", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

const runStorePaths: string[] = [];
const humanStorePaths: string[] = [];
let fileCounter = 0;
function nextRunStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-ipc-run-${Date.now()}-${fileCounter++}.json`);
  runStorePaths.push(path);
  return path;
}
function nextHumanStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-ipc-human-${Date.now()}-${fileCounter++}.json`);
  humanStorePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(runStorePaths.map((path) => rm(path, { force: true })));
  await Promise.all(humanStorePaths.map((path) => rm(path, { force: true })));
});

/** 手工构造挂起场景：run_states.json 含 waiting 断点快照 + 任务文件含 pending 任务（等价引擎挂起后落盘状态）。 */
async function setupWaitingRun(): Promise<{
  readonly taskId: string;
  readonly runStateStore: RunStateStore;
  readonly humanTaskStore: HumanTaskStore;
}> {
  const workflow = approvalWorkflow();
  const runStateStore = new RunStateStore({ filePath: nextRunStorePath() });
  const humanTaskStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
  const task = await humanTaskStore.create({
    workflowId: workflow.id,
    nodeId: "human",
    nodeName: "human",
    title: "审批",
  });
  const waiting: RunState = {
    runId: "ipc-submit-run",
    workflowId: workflow.id,
    workflow,
    nodeStates: { start: "Success", human: "WaitingForHuman", log: "Idle", end: "Idle" },
    nodeOutputs: {},
    contextSnapshot: { global: {}, workflow: {}, node: {} },
    status: "waiting",
    pendingNodeId: "human",
    pendingTaskId: task.id,
    updatedAt: 1000,
  };
  await runStateStore.create(waiting);
  return { taskId: task.id, runStateStore, humanTaskStore };
}

describe("task:submit 提交链路（resumeTask 闭环）", () => {
  test("提交人工产物 → 续跑至 success 且终态落盘 run_states.json", async () => {
    const { taskId, runStateStore, humanTaskStore } = await setupWaitingRun();

    // 与 handlers.ts task:submit 完全一致的调用形态：persist:true 续跑逐节点落盘。
    const result = await resumeTask(
      taskId,
      { persist: true, runStateStore, humanTaskStore },
      "approve",
    );
    expect(result.status).toBe("success");
    expect(result.nodeStates["human"]).toBe("Success");
    expect(result.nodeStates["log"]).toBe("Success");
    expect(result.nodeStates["end"]).toBe("Success");

    // 终态落盘：waiting 快照被覆盖为 success，不再残留 waiting。
    const snap = await runStateStore.getById("ipc-submit-run");
    expect(snap?.status).toBe("success");
    expect(snap?.nodeStates["human"]).toBe("Success");

    // 任务文件状态流转 completed + 产物写入。
    const updated = await humanTaskStore.getById(taskId);
    expect(updated?.status).toBe("completed");
    expect(updated?.result).toBe("approve");
  });

  test("提交已处理任务 → 中文错误（InvalidTaskStateError 语义，非 ok 而非抛）", async () => {
    const { taskId, runStateStore, humanTaskStore } = await setupWaitingRun();
    await resumeTask(taskId, { persist: true, runStateStore, humanTaskStore }, "approve");

    // 二次提交同一任务：任务已 completed → resumeTask 抛 InvalidTaskStateError（handlers 层转 { ok:false, message }）。
    await expect(
      resumeTask(taskId, { persist: true, runStateStore, humanTaskStore }, "again"),
    ).rejects.toThrow("current status");
  });
});

describe("task:skip 跳过链路（skipTask 闭环）", () => {
  test("跳过挂起任务 → 下游 Skipped 传播，任务落盘 skipped", async () => {
    const workflow = approvalWorkflow();
    const runStateStore = new RunStateStore({ filePath: nextRunStorePath() });
    const humanTaskStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const task = await humanTaskStore.create({
      workflowId: workflow.id,
      nodeId: "human",
      nodeName: "human",
      title: "审批",
    });
    const waiting: RunState = {
      runId: "ipc-skip-run",
      workflowId: workflow.id,
      workflow,
      nodeStates: { start: "Success", human: "WaitingForHuman", log: "Idle", end: "Idle" },
      nodeOutputs: {},
      contextSnapshot: { global: {}, workflow: {}, node: {} },
      status: "waiting",
      pendingNodeId: "human",
      pendingTaskId: task.id,
      updatedAt: 1000,
    };
    await runStateStore.create(waiting);

    // 与 handlers.ts task:skip 一致的调用形态。
    const result = await skipTask(task.id, { persist: true, runStateStore, humanTaskStore });
    expect(result.status).toBe("success");
    expect(result.nodeStates["human"]).toBe("Skipped");
    expect(result.nodeStates["log"]).toBe("Skipped");
    expect(result.nodeStates["end"]).toBe("Skipped");

    const updated = await humanTaskStore.getById(task.id);
    expect(updated?.status).toBe("skipped");
    expect((await runStateStore.getById("ipc-skip-run"))?.status).toBe("success");
  });
});

describe("task:reopen 回退链路", () => {
  test("completed 任务回退 pending，result 保留（恢复失败重试用）", async () => {
    const humanTaskStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const task = await humanTaskStore.create({
      workflowId: "reopen-wf",
      nodeId: "human",
      nodeName: "human",
      title: "审批",
    });
    await humanTaskStore.complete(task.id, "approve");

    const reopened = await humanTaskStore.reopen(task.id);
    expect(reopened.status).toBe("pending");
    expect(reopened.result).toBe("approve"); // AC4：用户输入不丢。
    const stored = await humanTaskStore.getById(task.id);
    expect(stored?.status).toBe("pending");
  });

  test("非 completed 任务回退 → 抛 InvalidTaskStateError（handlers 转中文错误）", async () => {
    const humanTaskStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const task = await humanTaskStore.create({
      workflowId: "reopen-wf2",
      nodeId: "human",
      nodeName: "human",
      title: "审批",
    });
    await expect(humanTaskStore.reopen(task.id)).rejects.toThrow("current status");
  });
});
