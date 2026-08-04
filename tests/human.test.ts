// 人工节点集成测试（AC3/AC4/AC5）：挂起→提交→继续、跳过、重启持久化、事件回调、状态校验。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { HumanTask } from "../src/human/types.js";
import { HumanTaskStore, InvalidTaskStateError } from "../src/human/HumanTaskStore.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → humanTask(title=审批) → log → end */
function makeApprovalWorkflow(humanParams: Readonly<Record<string, unknown>> = { title: "审批" }): Workflow {
  return {
    id: "human-wf",
    name: "human-approval",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", humanParams),
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

// 每个测试独立 store 文件，afterAll 统一清理。
const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-human-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
});

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

describe("AC3 人工节点挂起 → 提交 → 继续", () => {
  test("run 挂起返回 waitingTask / resume 后 success 且后续节点执行", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(makeApprovalWorkflow(), { humanTaskStore: store });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    expect(task.title).toBe("审批");
    expect(result.nodeStates["human"]).toBe("WaitingForHuman");
    expect(result.nodeStates["log"]).toBe("Idle");

    const resumed = await engine.resume(task.id, "approved");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeStates["human"]).toBe("Success");
    expect(resumed.nodeStates["log"]).toBe("Success");
    expect(resumed.nodeStates["end"]).toBe("Success");
    // log 节点执行过：引擎日志包含其消息。
    expect(engine.logs.some((entry) => entry.message === "after approval")).toBe(true);
    // 等待任务状态流转为 completed。
    const completed = await store.getById(task.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("approved");
  });

  test("挂起时 onHumanTaskCreated 事件触发并携带任务", async () => {
    let received: HumanTask | undefined;
    const engine = new ExecutionEngine(makeApprovalWorkflow(), {
      humanTaskStore: new HumanTaskStore({ filePath: nextStorePath() }),
      events: {
        onHumanTaskCreated: (task) => {
          received = task;
        },
      },
    });
    const result = await engine.run();
    expect(result.status).toBe("waiting");
    expect(received?.title).toBe("审批");
  });
});

describe("AC5 跳过人工节点后继续", () => {
  test("skip 后 humanTask Skipped 且下游 log 跳过传播", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(makeApprovalWorkflow(), { humanTaskStore: store });
    const result = await engine.run();
    const task = expectWaiting(result);

    const skipped = await engine.skip(task.id);
    expect(skipped.status).toBe("success");
    expect(skipped.nodeStates["human"]).toBe("Skipped");
    expect(skipped.nodeStates["log"]).toBe("Skipped");
    // 任务状态流转为 skipped。
    const stored = await store.getById(task.id);
    expect(stored?.status).toBe("skipped");
  });
});

describe("AC4 待办重启后仍存在", () => {
  test("store.create 后新 HumanTaskStore（同文件路径）listPending 含该任务", async () => {
    const filePath = nextStorePath();
    const store1 = new HumanTaskStore({ filePath });
    const created = await store1.create({
      workflowId: "wf-1",
      nodeId: "human",
      nodeName: "审批",
      title: "重启后仍存在",
    });

    const store2 = new HumanTaskStore({ filePath });
    const pending = await store2.listPending();
    expect(pending.some((task) => task.id === created.id)).toBe(true);
  });
});

describe("人工节点边界", () => {
  test("fallback=ai 兜底占位 → run 返回 failed 且错误含 AI 代做未实现", async () => {
    const engine = new ExecutionEngine(
      makeApprovalWorkflow({ title: "审批", fallback: "ai" }),
      { humanTaskStore: new HumanTaskStore({ filePath: nextStorePath() }) },
    );
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["human"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("AI 代做未实现");
  });

  test("completed 任务再 resume → 抛 InvalidTaskStateError", async () => {
    const engine = new ExecutionEngine(makeApprovalWorkflow(), {
      humanTaskStore: new HumanTaskStore({ filePath: nextStorePath() }),
    });
    const task = expectWaiting(await engine.run());
    await engine.resume(task.id, "approved");
    await expect(engine.resume(task.id, "again")).rejects.toThrow(InvalidTaskStateError);
  });

  test("resume 不存在的 taskId → 抛 InvalidTaskStateError", async () => {
    const engine = new ExecutionEngine(makeApprovalWorkflow(), {
      humanTaskStore: new HumanTaskStore({ filePath: nextStorePath() }),
    });
    await expect(engine.resume("no-such-task")).rejects.toThrow(InvalidTaskStateError);
  });

  test("store.defer 后任务状态为 deferred", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const created = await store.create({
      workflowId: "wf-defer",
      nodeId: "human",
      nodeName: "审批",
      title: "延后任务",
    });
    const deferred = await store.defer(created.id);
    expect(deferred.status).toBe("deferred");
    const stored = await store.getById(created.id);
    expect(stored?.status).toBe("deferred");
  });
});

describe("reopen 回退（恢复失败/多轮中断）", () => {
  test("reopen 将 completed 回退 pending：result 保留（AC4 不丢用户输入），completedAt 清除", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const created = await store.create({
      workflowId: "wf-reopen",
      nodeId: "ai",
      nodeName: "AI 节点",
      title: "AI 工具审批",
      meta: { kind: "ai_interrupt", threadId: "t-1", checkpointId: "cp-1" },
    });
    const completed = await store.complete(created.id, { type: "approve" });
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ type: "approve" });

    const reopened = await store.reopen(completed.id);
    expect(reopened.status).toBe("pending");
    expect(reopened.result).toEqual({ type: "approve" });
    expect(reopened.completedAt).toBeUndefined();
    // 持久化后可查。
    const stored = await store.getById(created.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.result).toEqual({ type: "approve" });
    expect(stored?.completedAt).toBeUndefined();
  });

  test("reopen 可选更新 meta（多轮中断更新 checkpointId）", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const created = await store.create({
      workflowId: "wf-reopen-meta",
      nodeId: "ai",
      nodeName: "AI 节点",
      title: "AI 工具审批",
      meta: { kind: "ai_interrupt", threadId: "t-1", checkpointId: "cp-1" },
    });
    await store.complete(created.id);
    const reopened = await store.reopen(created.id, { kind: "ai_interrupt", threadId: "t-1", checkpointId: "cp-2" });
    expect(reopened.meta?.["checkpointId"]).toBe("cp-2");
  });

  test("reopen 非 completed 任务抛 InvalidTaskStateError", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const created = await store.create({
      workflowId: "wf-reopen-err",
      nodeId: "ai",
      nodeName: "AI 节点",
      title: "AI 工具审批",
    });
    await expect(store.reopen(created.id)).rejects.toThrow(InvalidTaskStateError);
  });
});
