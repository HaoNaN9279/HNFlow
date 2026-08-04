// parallel 节点持久化恢复 e2e（v0.2.3 AC3/AC4 恢复部分）：挂起/上下文保留/失败中断/断点/连续挂起/持久化。
// 全内置节点（不注册自定义），恢复流程照 loop-recovery.test.ts（SQLite 临时库 + afterAll 清理）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { buildEngineFromRunState, continueRun, resumeTask } from "../src/execution/resume.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { openDatabase, SqliteHumanTaskStore, SqliteRunStateStore, type SqliteDatabase } from "../src/db/index.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\parallel-recovery-e2e";
let dbCounter = 0;
function nextDbPath(prefix: string): string { return join(TEMP_BASE, `${prefix}-${Date.now()}-${dbCounter++}.db`); }

const sharedDbs: SqliteDatabase[] = [];
beforeAll(async () => { await mkdir(TEMP_BASE, { recursive: true }); });
afterAll(async () => { for (const db of sharedDbs) db.close(); await rmRetry(TEMP_BASE); }, 30000);

/** 带重试的递归删除：Windows sqlite 句柄释放可达数秒（照既有测试模式）。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true);
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

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}
function makeParallelNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("parallel");
  return { id, type: "parallel", name: "并行分支", params, inputs: def.inputs, outputs: def.outputs };
}
/** 分支：写 workflow:<key>=<value> + endInput，endResult 为 endInput 值。 */
function valBranch(bid: string, key: string, value: unknown, endInput: string): Workflow {
  return { id: `vb-${bid}`, name: bid, version: "0.1.0", nodes: [
    makeNode("start", "start"),
    makeNode("sv1", "setVariable", { target: `workflow:${key}`, value }),
    makeNode("sv2", "setVariable", { target: "workflow:endInput", value: endInput }),
    makeNode("end", "end"),
  ], edges: [] };
}
/** 分支：humanTask 挂起（hid 透传 task_result 后通过）。 */
function waitBranch(bid: string, hid: string, title: string): Workflow {
  return { id: `wb-${bid}`, name: bid, version: "0.1.0", nodes: [
    makeNode("start", "start"),
    makeNode(hid, "humanTask", { title }),
    makeNode("end", "end"),
  ], edges: [{ id: "e1", sourceNodeId: hid, sourcePortId: "output", targetNodeId: "end", targetPortId: "in" }] };
}
/** parent：start → par → end（results 连 end）。 */
function parentWorkflow(id: string, branches: readonly unknown[]): Workflow {
  return { id, name: "parent", version: "0.1.0", nodes: [
    makeNode("start", "start"),
    makeParallelNode("par", { branches }),
    makeNode("end", "end"),
  ], edges: [{ id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" }] };
}
/** 挂起场景：b1 写 x=1 快速完成、b2 humanTask 挂起。 */
function xWaitWorkflow(id: string): Workflow {
  return parentWorkflow(id, [
    { id: "b1", workflow: valBranch("b1", "x", 1, "A") },
    { id: "b2", workflow: waitBranch("b2", "human", "并行分支审批") },
  ]);
}
function expectWaiting(result: { status: string; waitingTask?: HumanTask }): HumanTask {
  if (result.status !== "waiting") throw new Error(`expected waiting, got: ${result.status}`);
  const task = result.waitingTask;
  if (task === undefined) throw new Error("expected waitingTask");
  return task;
}
function expectSnap(snap: RunState | undefined): RunState {
  if (snap === undefined) throw new Error("expected run state");
  return snap;
}

describe("parallel 挂起恢复（多分支）", () => {
  test("b1 完成写 x=1、b2 挂起 → waiting；resume 后 b2 完成、x 保留、b1 不重复合并", async () => {
    const dbPath = nextDbPath("wait");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const wf = xWaitWorkflow("par-wait-rec");
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const engine = new ExecutionEngine(wf, { runId: "par-wait-rec-1", persist: true, runStateStore: runStore, humanTaskStore: humanStore });
    const r1 = await engine.run();
    expect(r1.status).toBe("waiting");
    const task = expectWaiting(r1);
    expect(task.workflowId).toBe("par-wait-rec:par:b2");
    expect(task.nodeId).toBe("human");
    // 断点快照：b1 已完成（doneBranches 只含 b1），b1 的 x=1 已合并进父 workflow。
    const snap = expectSnap(await runStore.getById("par-wait-rec-1"));
    expect(snap.contextSnapshot.node["node:par"]?.["doneBranches"]).toEqual(["b1"]);
    // resume：parallel 重跑读 doneBranches 跳过 b1，b2 读 task_result 完成；x 保持 1（b1 不重跑不重复合并）。
    const resumed = await engine.resume(task.id, "approve");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeOutputs["par"]?.["results"]).toEqual({ b2: "approve" });
    expect(engine.getWorkflowVariable("x")).toBe(1);
    expect(await humanStore.listAll()).toHaveLength(1);
    expect(await humanStore.listPending()).toHaveLength(0);
  });
});

describe("parallel 挂起后上下文保留", () => {
  test("waiting 快照已持久化 b1 合并的 x=1 与 doneBranches", async () => {
    const dbPath = nextDbPath("ctx");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const wf = xWaitWorkflow("par-ctx-rec");
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const engine = new ExecutionEngine(wf, { runId: "par-ctx-rec-1", persist: true, runStateStore: runStore, humanTaskStore: humanStore });
    const r1 = await engine.run();
    const task = expectWaiting(r1);
    // b1 合并的变量在 waiting 快照中已持久化（恢复时无需重跑 b1 即可读到 x）。
    const snap = expectSnap(await runStore.getById("par-ctx-rec-1"));
    expect(snap.status).toBe("waiting");
    expect(snap.pendingTaskId).toBe(task.id);
    expect(snap.contextSnapshot.workflow["x"]).toBe(1);
    expect(snap.contextSnapshot.node["node:par"]?.["doneBranches"]).toEqual(["b1"]);
  });
});

describe("parallel 失败中断恢复", () => {
  test("分支失败（ParallelBranchFailedError）被外层 tryCatch 捕获 → 流程继续", async () => {
    const badBranch: Workflow = { id: "bad-b", name: "b", version: "0.1.0", nodes: [
      makeNode("start", "start"),
      makeNode("bad", "setVariable", { value: 1 }), // 缺 target → 子引擎失败 → 分支失败
      makeNode("end", "end"),
    ], edges: [] };
    const tryBody: Workflow = { id: "tc-body", name: "body", version: "0.1.0", nodes: [
      makeNode("start", "start"),
      makeParallelNode("par", { branches: [
        { id: "b1", workflow: valBranch("b1", "x", 1, "A") },
        { id: "b2", workflow: badBranch },
      ] }),
      makeNode("end", "end"),
    ], edges: [{ id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" }] };
    const wf: Workflow = { id: "par-tc-fail", name: "parent", version: "0.1.0", nodes: [
      makeNode("start", "start"),
      makeNode("tc", "tryCatch", { body: tryBody }),
      makeNode("end2", "end"),
    ], edges: [{ id: "e2", sourceNodeId: "tc", sourcePortId: "catch", targetNodeId: "end2", targetPortId: "in" }] };
    const engine = new ExecutionEngine(wf);
    const r = await engine.run();
    // 失败被捕获：tryCatch 自身 Success，catch 连 end2 → 流程继续 success。
    expect(r.status).toBe("success");
    expect(r.nodeStates["tc"]).toBe("Success");
    expect(r.nodeStates["end2"]).toBe("Success");
    const caught = engine.getWorkflowVariable("endResult");
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught) ?? "").toContain("b2");
  });
});

describe("parallel 断点快照恢复（doneBranches 跳过）", () => {
  test("构造断点（doneBranches=[b1]、父 x=1）：b1 跳过、b2 执行、x 不重复合并", async () => {
    const dbPath = nextDbPath("rec");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const wf = parentWorkflow("par-rec-snap", [
      { id: "b1", workflow: valBranch("b1", "x", "B1", "B") }, // 若重跑会覆盖 x
      { id: "b2", workflow: valBranch("b2", "y", "B2", "B2") },
    ]);
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    // 断点：b1 已在中断前合并（x=1）+ doneBranches 记录，b2 未开始。
    const runState: RunState = { runId: "par-rec-snap-1", workflowId: wf.id, workflow: wf,
      nodeStates: { start: "Success", par: "Idle", end: "Idle" }, nodeOutputs: {},
      contextSnapshot: { global: {}, workflow: { x: 1 }, node: { "node:par": { doneBranches: ["b1"] } } },
      status: "running", updatedAt: 1000 };
    await runStore.create(runState);
    const engine = buildEngineFromRunState(runState, { runStateStore: runStore });
    const r = await continueRun(engine, runState);
    expect(r.status).toBe("success");
    // b1 跳过（若重跑会覆盖 x 为 "B1"）：x 保持断点值；b2 执行并合并 y。
    expect(engine.getWorkflowVariable("x")).toBe(1);
    expect(engine.getWorkflowVariable("y")).toBe("B2");
    expect(r.nodeOutputs["par"]?.["results"]).toEqual({ b2: "B2" });
  });
});

describe("parallel 连续挂起恢复", () => {
  test("b1 挂起恢复后 b2 又挂起：二次 waiting、任务不同、最终完成", async () => {
    const dbPath = nextDbPath("seq");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const wf = parentWorkflow("par-seq", [
      { id: "b1", workflow: waitBranch("b1", "human1", "审批1") },
      { id: "b2", workflow: waitBranch("b2", "human2", "审批2") },
    ]);
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const opts = { runStateStore: runStore, humanTaskStore: humanStore, persist: true };
    const r1 = await new ExecutionEngine(wf, { runId: "par-seq-1", ...opts }).run();
    expect(r1.status).toBe("waiting");
    const task1 = expectWaiting(r1);
    // 恢复 b1 → b2 挂起：二次 waiting，任务不同（复用 b2 已创建任务，不重复创建）。
    const r2 = await resumeTask(task1.id, opts, "A");
    expect(r2.status).toBe("waiting");
    const task2 = expectWaiting(r2);
    expect(task2.id).not.toBe(task1.id);
    expect(task2.nodeId).toBe("human2");
    const r3 = await resumeTask(task2.id, opts, "B");
    expect(r3.status).toBe("success");
    // b1 已完成（doneBranches 跳过）：results 只含本次成功的 b2（b1 结果已在中断前合并）。
    expect(r3.nodeOutputs["par"]?.["results"]).toEqual({ b2: "B" });
    expect(await humanStore.listAll()).toHaveLength(2);
    expect(await humanStore.listPending()).toHaveLength(0);
  });
});

describe("parallel 持久化模式", () => {
  test("Sqlite 全程 RunState 更新正确：waiting 快照 → resume → 终态快照", async () => {
    const dbPath = nextDbPath("persist");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const wf = xWaitWorkflow("par-persist-rec");
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const r1 = await new ExecutionEngine(wf, { runId: "par-persist-rec-1", persist: true, runStateStore: runStore, humanTaskStore: humanStore }).run();
    expect(r1.status).toBe("waiting");
    const task = expectWaiting(r1);
    // waiting 快照：挂起任务与已完成分支（b1 结果已合并）均已落盘。
    const snap1 = expectSnap(await runStore.getById("par-persist-rec-1"));
    expect(snap1.status).toBe("waiting");
    expect(snap1.pendingTaskId).toBe(task.id);
    expect(snap1.contextSnapshot.workflow["x"]).toBe(1);
    expect(snap1.contextSnapshot.node["node:par"]?.["doneBranches"]).toEqual(["b1"]);
    // resume 后终态快照：全部分支完成，status 流转 success，合并结果保留。
    const r2 = await resumeTask(task.id, { runStateStore: runStore, humanTaskStore: humanStore, persist: true }, "approve");
    expect(r2.status).toBe("success");
    expect(r2.nodeOutputs["par"]?.["results"]).toEqual({ b2: "approve" });
    const snap2 = expectSnap(await runStore.getById("par-persist-rec-1"));
    expect(snap2.status).toBe("success");
    expect(snap2.contextSnapshot.workflow["x"]).toBe(1);
    expect(snap2.contextSnapshot.node["node:par"]?.["doneBranches"]).toEqual(["b1", "b2"]);
  });
});
