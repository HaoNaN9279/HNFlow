// 断点续跑集成测试：persist → 丢弃实例 → resumeRun/resumeTask/skipTask 恢复执行。
// 覆盖：不重跑 Success、上下文还原、失败节点重跑、挂起重启 resumeTask/skipTask、
// waiting 拒绝、子图挂起跨重启（任务复用）、restoreState 单元级。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import type { NodeStatus } from "../src/execution/NodeState.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";
import { resumeRun, resumeTask, skipTask } from "../src/execution/resume.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** 基于内置节点 + 自定义定义构建独立 registry（闭包计数器隔离）。 */
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
}

/** 计数命令节点：每次 execute 递增，用于断言"不重跑已 Success 节点"。 */
function countCmdNode(id: string): Node {
  return {
    id,
    type: "countCmd",
    name: id,
    params: {},
    inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
  };
}
function countCmdDef(state: { runs: number }): INodeDefinition {
  return {
    type: "countCmd",
    name: "countCmd",
    inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
    async execute() {
      state.runs++;
      return { count: state.runs };
    },
  };
}

/** 首次执行失败、之后成功的节点（失败恢复验证）。 */
function boomOnceNode(id: string): Node {
  return { id, type: "boomOnce", name: id, params: {}, inputs: [], outputs: [] };
}
function boomOnceDef(state: { runs: number }): INodeDefinition {
  return {
    type: "boomOnce",
    name: "boomOnce",
    inputs: [],
    outputs: [],
    async execute() {
      state.runs++;
      if (state.runs === 1) throw new Error("boom exploded");
      return {};
    },
  };
}

/** 读取指定 workflow 变量的观察节点（上下文还原验证）。 */
function readVarNode(id: string, target: string): Node {
  return {
    id,
    type: "readVar",
    name: id,
    params: { target },
    inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
    outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  };
}
const readVarDef: INodeDefinition = {
  type: "readVar",
  name: "readVar",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    const target = ctx.node.params["target"];
    return { out: ctx.getByPath(typeof target === "string" ? target : "workflow:y") };
  },
};

function makeSubworkflowNode(id: string, subWorkflow: Workflow): Node {
  return {
    id,
    type: "subworkflow",
    name: "子工作流",
    params: { subworkflow: subWorkflow },
    inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

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

/** start → humanTask → countCmd → end 的挂起工作流。 */
function humanWorkflow(): Workflow {
  return {
    id: "human-resume-wf",
    name: "human-resume",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", { title: "审批" }),
      countCmdNode("cmd"),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "cmd", targetPortId: "in" },
      { id: "e3", sourceNodeId: "cmd", sourcePortId: "count", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

const runStorePaths: string[] = [];
const humanStorePaths: string[] = [];
let fileCounter = 0;
function nextRunStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-resume-run-${Date.now()}-${fileCounter++}.json`);
  runStorePaths.push(path);
  return path;
}
function nextHumanStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-resume-human-${Date.now()}-${fileCounter++}.json`);
  humanStorePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(runStorePaths.map((path) => rm(path, { force: true })));
  await Promise.all(humanStorePaths.map((path) => rm(path, { force: true })));
});

describe("断点续跑基础", () => {
  test("persist 全跑后 resumeRun 不重跑已 Success；部分断点续跑也只跑剩余节点", async () => {
    const cmdState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(cmdState)]);
    const workflow: Workflow = {
      id: "resume-basic-wf",
      name: "resume-basic",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("svA", "setVariable", { target: "workflow:x", value: 1 }),
        countCmdNode("cmd"),
        makeNode("svB", "setVariable", { target: "workflow:x", value: 2 }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "svA", targetPortId: "in" },
        { id: "e2", sourceNodeId: "svA", sourcePortId: "out", targetNodeId: "cmd", targetPortId: "in" },
        { id: "e3", sourceNodeId: "cmd", sourcePortId: "count", targetNodeId: "svB", targetPortId: "in" },
        { id: "e4", sourceNodeId: "svB", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const engine1 = new ExecutionEngine(workflow, {
      registry: reg,
      runId: "resume-basic",
      persist: true,
      runStateStore: store,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("success");
    expect(r1.nodeStates["cmd"]).toBe("Success");
    expect(cmdState.runs).toBe(1);
    // 全部完成 → resumeRun 直接 success，不重跑任何节点。
    const r2 = await resumeRun("resume-basic", { registry: reg, runStateStore: store });
    expect(r2.status).toBe("success");
    expect(cmdState.runs).toBe(1);
    // 制造断点：svB/end 重置 Idle（模拟中断在 cmd 后），恢复续跑只跑剩余节点。
    const snap = await store.getById("resume-basic");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    const modified: RunState = { ...snap, nodeStates: { ...snap.nodeStates, svB: "Idle", end: "Idle" } };
    await store.update(modified);
    const events: Array<{ nodeId: string; to: NodeStatus }> = [];
    const r3 = await resumeRun("resume-basic", {
      registry: reg,
      runStateStore: store,
      events: {
        onNodeStateChange: (info) => events.push({ nodeId: info.nodeId, to: info.to }),
      },
    });
    expect(r3.status).toBe("success");
    expect(r3.nodeStates["svB"]).toBe("Success");
    expect(r3.nodeStates["end"]).toBe("Success");
    expect(cmdState.runs).toBe(1); // cmd 未重跑
    const reran = new Set(events.map((entry) => entry.nodeId));
    expect(reran.has("start")).toBe(false);
    expect(reran.has("svA")).toBe(false);
    expect(reran.has("cmd")).toBe(false);
    expect(reran.has("svB")).toBe(true);
    expect(reran.has("end")).toBe(true);
  });
});

describe("上下文还原", () => {
  test("断点后节点读恢复前的 workflow 变量", async () => {
    const reg = makeRegistry([readVarDef]);
    const workflow: Workflow = {
      id: "ctx-restore-wf",
      name: "ctx-restore",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("svA", "setVariable", { target: "workflow:x", value: 1 }),
        makeNode("svB", "setVariable", { target: "workflow:y", value: "${workflow:x}-ok" }),
        readVarNode("readY", "workflow:y"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "svA", targetPortId: "in" },
        { id: "e2", sourceNodeId: "svA", sourcePortId: "out", targetNodeId: "svB", targetPortId: "in" },
        { id: "e3", sourceNodeId: "svB", sourcePortId: "out", targetNodeId: "readY", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const runState: RunState = {
      runId: "resume-ctx",
      workflowId: workflow.id,
      workflow,
      nodeStates: { start: "Success", svA: "Success", svB: "Idle", readY: "Idle" },
      nodeOutputs: {},
      contextSnapshot: { global: {}, workflow: { x: 1 }, node: {} },
      status: "running",
      updatedAt: 1000,
    };
    await store.create(runState);
    const result = await resumeRun("resume-ctx", { registry: reg, runStateStore: store });
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["readY"]?.["out"]).toBe("1-ok");
  });
});

describe("失败恢复", () => {
  test("失败节点重跑后成功（continueRun 从第一个 Failed 继续）", async () => {
    const boomState = { runs: 0 };
    const reg = makeRegistry([boomOnceDef(boomState)]);
    const workflow: Workflow = {
      id: "fail-retry-wf",
      name: "fail-retry",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        boomOnceNode("boom"),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const engine1 = new ExecutionEngine(workflow, {
      registry: reg,
      runId: "resume-fail",
      persist: true,
      runStateStore: store,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("failed");
    expect(r1.nodeStates["boom"]).toBe("Failed");
    expect(boomState.runs).toBe(1);
    const snap = await store.getById("resume-fail");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    expect(snap.status).toBe("failed");
    expect(snap.nodeStates["boom"]).toBe("Failed");
    const r2 = await resumeRun("resume-fail", { registry: reg, runStateStore: store });
    expect(r2.status).toBe("success");
    expect(boomState.runs).toBe(2); // 失败节点重跑
    expect(r2.nodeStates["boom"]).toBe("Success");
    expect(r2.nodeStates["end"]).toBe("Success");
  });
});

describe("挂起退出 → 重启 resumeTask/skipTask", () => {
  test("resumeTask 继续成功，任务 completed", async () => {
    const cmdState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(cmdState)]);
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const humanStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const engine1 = new ExecutionEngine(humanWorkflow(), {
      registry: reg,
      runId: "resume-task-1",
      persist: true,
      runStateStore: store,
      humanTaskStore: humanStore,
    });
    const r1 = await engine1.run();
    const task = expectWaiting(r1);
    expect(task.status).toBe("pending");
    // 丢弃实例 → resumeTask 提供人工产物继续。
    const r2 = await resumeTask(task.id, { registry: reg, runStateStore: store, humanTaskStore: humanStore }, "approve");
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["human"]).toBe("Success");
    expect(r2.nodeStates["cmd"]).toBe("Success");
    expect(cmdState.runs).toBe(1);
    const updated = await humanStore.getById(task.id);
    expect(updated?.status).toBe("completed");
  });

  test("skipTask 跳过挂起任务，下游 Skipped", async () => {
    const cmdState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(cmdState)]);
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const humanStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const engine1 = new ExecutionEngine(humanWorkflow(), {
      registry: reg,
      runId: "resume-skip-1",
      persist: true,
      runStateStore: store,
      humanTaskStore: humanStore,
    });
    const r1 = await engine1.run();
    const task = expectWaiting(r1);
    const r2 = await skipTask(task.id, { registry: reg, runStateStore: store, humanTaskStore: humanStore });
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["human"]).toBe("Skipped");
    expect(r2.nodeStates["cmd"]).toBe("Skipped");
    expect(r2.nodeStates["end"]).toBe("Skipped");
    expect(cmdState.runs).toBe(0); // 下游未执行
    const updated = await humanStore.getById(task.id);
    expect(updated?.status).toBe("skipped");
  });
});

describe("waiting 拒绝", () => {
  test("run 挂起退出后 resumeRun 抛错提示用 resumeTask", async () => {
    const cmdState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(cmdState)]);
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const humanStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const engine1 = new ExecutionEngine(humanWorkflow(), {
      registry: reg,
      runId: "resume-wait-reject",
      persist: true,
      runStateStore: store,
      humanTaskStore: humanStore,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("waiting");
    await expect(resumeRun("resume-wait-reject", { runStateStore: store })).rejects.toThrow(
      "run is waiting, use resumeTask instead",
    );
  });
});

describe("子图内挂起跨重启", () => {
  test("resumeTask 跨重启继续成功，任务数仍=1（findPending 复用）", async () => {
    const sub: Workflow = {
      id: "sub-resume",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "子图审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "se1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-resume",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "pe1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextRunStorePath() });
    const humanStore = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const engine1 = new ExecutionEngine(parent, {
      runId: "resume-sub",
      persist: true,
      runStateStore: store,
      humanTaskStore: humanStore,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("waiting");
    const task = expectWaiting(r1);
    expect(task.workflowId).toBe("parent-resume:sub");
    expect(task.nodeId).toBe("human");
    expect(await humanStore.listAll()).toHaveLength(1);
    // 丢弃实例 → resumeTask 跨重启恢复。
    const r2 = await resumeTask(task.id, { runStateStore: store, humanTaskStore: humanStore }, "ok");
    expect(r2.status).toBe("success");
    expect(r2.nodeOutputs["sub"]?.["out"]).toBe("ok");
    // 复用已建任务：总数仍=1，无残留 pending。
    expect(await humanStore.listAll()).toHaveLength(1);
    expect(await humanStore.listPending()).toHaveLength(0);
  });
});

describe("restoreState 单元级", () => {
  test("restoreState 恢复 nodeStates/context，isReadOnly=true，workflowSnapshot 深拷贝独立", () => {
    const workflow: Workflow = {
      id: "restore-wf",
      name: "restore",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 1 }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "sv", targetPortId: "in" },
        { id: "e2", sourceNodeId: "sv", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(workflow);
    engine.restoreState(
      { start: "Success", sv: "Success", end: "Idle" },
      { sv: { out: "done" } },
      { global: { g: 1 }, workflow: { x: 42 }, node: { "node:sv": { tag: "t" } } },
    );
    expect(engine.isReadOnly).toBe(true);
    expect(engine.getWorkflowVariable("x")).toBe(42);
    // workflowSnapshot 深拷贝：修改返回对象不影响引擎内部。
    const snap = engine.workflowSnapshot;
    expect(snap).not.toBe(workflow);
    const mutable = JSON.parse(JSON.stringify(snap)) as {
      nodes: Array<{ id: string; params: Record<string, unknown> }>;
    };
    if (mutable.nodes[0] === undefined) {
      throw new Error("expected node");
    }
    mutable.nodes[0].params["evil"] = true;
    const snap2 = engine.workflowSnapshot;
    expect(snap2.nodes[0]?.params["evil"]).toBeUndefined();
  });

  test("workflowSnapshot 递归深拷贝含嵌套 subworkflow", () => {
    const sub: Workflow = {
      id: "sub-x",
      name: "子",
      version: "0.1.0",
      nodes: [makeNode("s", "start")],
      edges: [],
    };
    const workflow: Workflow = {
      id: "wf-x",
      name: "x",
      version: "0.1.0",
      nodes: [makeNode("start", "start"), makeSubworkflowNode("subw", sub)],
      edges: [],
    };
    const engine = new ExecutionEngine(workflow);
    const snap = engine.workflowSnapshot;
    expect(snap).not.toBe(workflow);
    // subworkflow 节点经 params.subworkflow 携带子图，深拷贝保证嵌套子图独立。
    const subNode = snap.nodes.find((node) => node.id === "subw");
    const subSnap = subNode?.params["subworkflow"];
    expect(subSnap).toBeDefined();
    expect(subSnap).not.toBe(sub);
  });
});
