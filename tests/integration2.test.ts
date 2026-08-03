// v0.1.2 全功能集成验证（AC2 + 组合场景 AC6-AC8）：子工作流参数传入/结果返回、
// 子工作流+人工+断点全链路（resumeTask/skipTask 跨重启、失败重跑）。
// AC1、AC3-AC5 见 tests/integration.test.ts。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { INodeDefinition } from "../src/execution/types.js";
import type { HumanTask } from "../src/human/types.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { Node, Port, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";
import { resumeRun, resumeTask, skipTask } from "../src/execution/resume.js";
import { isWorkflow } from "../src/subgraph/shared.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";
const TEMP_DIR = join(TEMP_BASE, `hnflow-integration2-${Date.now()}`);
let fileCounter = 0;
function nextStorePath(name: string): string {
  return join(TEMP_DIR, `${name}-${fileCounter++}.json`);
}
afterAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
});

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}
/** 计数命令节点：每次 execute 递增，验证下游是否执行。 */
function countCmdNode(id: string): Node {
  return {
    id, type: "countCmd", name: id, params: {}, inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
  };
}
function countCmdDef(state: { runs: number }): INodeDefinition {
  return {
    type: "countCmd", name: "countCmd", inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
    async execute() {
      state.runs++;
      return { count: state.runs };
    },
  };
}
function makeSubworkflowNode(id: string, subWorkflow: Workflow, inputPorts: readonly Port[] = []): Node {
  return {
    id, type: "subworkflow", name: "子工作流", params: { subworkflow: subWorkflow },
    inputs: [...inputPorts], outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
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
/** 组合 A/B 共享父图：start → S(subworkflow, 子图含 humanTask) → cmd(countCmd) → end。 */
function comboParent(id: string, sub: Workflow): Workflow {
  return {
    id,
    name: id,
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeSubworkflowNode("S", sub),
      countCmdNode("cmd"),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "pe1", sourceNodeId: "S", sourcePortId: "out", targetNodeId: "cmd", targetPortId: "in" },
      { id: "pe2", sourceNodeId: "cmd", sourcePortId: "count", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}
/** persist 跑图直到挂起，返回等待任务（模拟实例丢弃前的状态）。 */
async function runToPending(
  parent: Workflow,
  runId: string,
  reg: NodeRegistry,
  store: RunStateStore,
  humanStore: HumanTaskStore,
): Promise<HumanTask> {
  const engine1 = new ExecutionEngine(parent, {
    registry: reg, runId, persist: true, runStateStore: store, humanTaskStore: humanStore,
  });
  return expectWaiting(await engine1.run());
}

describe("AC2 子工作流参数传入/结果返回", () => {
  test("AC2 父 setVariable 传参 → 子图读到 workflow:params:x → endResult 返回父 out", async () => {
    const sub: Workflow = {
      id: "ac2-sub",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "${workflow:params:x}" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "ac2-wf",
      name: "ac2",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:params:x", value: 41 }),
        makeSubworkflowNode("sub", sub, [
          { id: "p_x", name: "x", type: "any", direction: "in", binding: "workflow:params:x" },
        ]),
        makeNode("end", "end"),
      ],
      edges: [{ id: "e1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    // 插值 String(41)="41" → endInput → endResult → 父 sub.out。
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("41");
  });
});
describe("组合场景 A：子工作流+人工+断点全链路", () => {
  test("AC6 挂起退出后 resumeTask 跨重启 → S out=approved、cmd Success、任务 completed", async () => {
    const countState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(countState)]);
    const sub: Workflow = {
      id: "combo-sub-a",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:seed", value: "seed" }),
        makeNode("human", "humanTask", { title: "审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "se1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextStorePath("run") });
    const humanStore = new HumanTaskStore({ filePath: nextStorePath("human") });
    const task = await runToPending(comboParent("combo-a", sub), "combo-a-run", reg, store, humanStore);
    expect(task.workflowId).toBe("combo-a:S");
    expect(task.nodeId).toBe("human");
    expect(await humanStore.listPending()).toHaveLength(1);
    // 丢弃实例 → resumeTask 跨重启提供人工产物。
    const r2 = await resumeTask(task.id, { registry: reg, runStateStore: store, humanTaskStore: humanStore }, "approved");
    expect(r2.status).toBe("success");
    expect(r2.nodeOutputs["S"]?.["out"]).toBe("approved");
    expect(r2.nodeStates["cmd"]).toBe("Success");
    expect(countState.runs).toBe(1);
    expect((await humanStore.getById(task.id))?.status).toBe("completed");
  });
});
describe("组合场景 B：skip 跨重启", () => {
  test("AC7 挂起退出后 skipTask → 下游 Skipped 传播、任务 skipped", async () => {
    const countState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(countState)]);
    const sub: Workflow = {
      id: "combo-sub-b",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "se1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextStorePath("run") });
    const humanStore = new HumanTaskStore({ filePath: nextStorePath("human") });
    const task = await runToPending(comboParent("combo-b", sub), "combo-b-run", reg, store, humanStore);
    const r2 = await skipTask(task.id, { registry: reg, runStateStore: store, humanTaskStore: humanStore });
    expect(r2.status).toBe("success");
    // 父 S 保留挂起残留（子图任务跳过、父节点不再产出结果），下游自动跳过传播。
    expect(r2.nodeStates["S"]).toBe("WaitingForHuman");
    expect(r2.nodeStates["cmd"]).toBe("Skipped");
    expect(r2.nodeStates["end"]).toBe("Skipped");
    expect(countState.runs).toBe(0);
    expect((await humanStore.getById(task.id))?.status).toBe("skipped");
  });
});
describe("组合场景 C：失败+断点", () => {
  test("AC8 子工作流失败 → persist → 修改快照后 resumeRun 从 Failed 重跑成功", async () => {
    const sub: Workflow = {
      id: "combo-sub-c",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("cmd", "command", { command: "node", args: ["-e", "process.exit(1)"], failOnNonZero: true }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "combo-c",
      name: "combo-c",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("S", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "pe1", sourceNodeId: "S", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextStorePath("run") });
    const engine1 = new ExecutionEngine(parent, { runId: "combo-c-run", persist: true, runStateStore: store });
    const r1 = await engine1.run();
    expect(r1.status).toBe("failed");
    expect(r1.nodeStates["S"]).toBe("Failed");
    if (r1.error === undefined) {
      throw new Error("expected error message");
    }
    expect(r1.error).toContain("子工作流执行失败");
    const snap = await store.getById("combo-c-run");
    if (snap === undefined) throw new Error("expected run state");
    expect(snap.status).toBe("failed");
    // 修改快照：子图 command 改为成功退出 → resumeRun 从 Failed 的 S 节点重跑。
    const subNode = snap.workflow.nodes.find((node) => node.id === "S");
    if (subNode === undefined) throw new Error("expected sub node");
    const subWf = subNode.params["subworkflow"];
    if (!isWorkflow(subWf)) throw new Error("expected subworkflow params");
    const fixedNodes = subWf.nodes.map((node) =>
      node.id === "cmd" ? { ...node, params: { ...node.params, args: ["-e", "process.exit(0)"] } } : node,
    );
    const newSubWf: Workflow = { ...subWf, nodes: fixedNodes };
    const newSubNode: Node = { ...subNode, params: { ...subNode.params, subworkflow: newSubWf } };
    const modified: RunState = {
      ...snap,
      workflow: { ...snap.workflow, nodes: snap.workflow.nodes.map((node) => (node.id === "S" ? newSubNode : node)) },
    };
    await store.update(modified);
    const r2 = await resumeRun("combo-c-run", { runStateStore: store });
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["S"]).toBe("Success");
    expect(r2.nodeStates["end"]).toBe("Success");
  });
});
