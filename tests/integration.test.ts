// v0.1.2 全功能集成验证（AC1、AC3-AC5）：子图打包/展开往返、断点续跑（start 不重跑）、
// 运行时编辑锁、草稿替换持久化往返。AC2 参数传入/结果返回及组合场景见 tests/integration2.test.ts。
import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { NodeStatus } from "../src/execution/NodeState.js";
import type { Edge, Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";
import { resumeRun } from "../src/execution/resume.js";
import { expandSubgraph, packageSubgraph } from "../src/subgraph/index.js";
import { commitDraft, createDraft, type Draft } from "../src/editing/index.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";
const TEMP_DIR = join(TEMP_BASE, `hnflow-integration-${Date.now()}`);
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
/** 透传节点：有 in/out 端口（端口齐全保证 expand 边界还原）。 */
function makePassNode(id: string, outPortId = "out"): Node {
  return {
    id,
    type: "pass",
    name: id,
    params: {},
    inputs: [{ id: "in", name: "入", type: "any", direction: "in" }],
    outputs: [{ id: outPortId, name: "出", type: "any", direction: "out" }],
  };
}
/** 计数命令节点（仅构造不执行）：AC1 打包图中间节点。 */
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
/** 展开还原归一化：去子图 id 前缀、还原打包时改写的 binding。 */
function normalizeNode(node: Node, prefix: string): Node {
  const id = node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
  const inputs = node.inputs.map((port) =>
    port.binding === `workflow:params:${port.id}`
      ? { id: port.id, name: port.name, type: port.type, direction: port.direction }
      : port,
  );
  return { ...node, id, inputs };
}
function normalizeEdge(edge: Edge, prefix: string): Edge {
  return {
    ...edge,
    sourceNodeId: edge.sourceNodeId.startsWith(prefix)
      ? edge.sourceNodeId.slice(prefix.length)
      : edge.sourceNodeId,
    targetNodeId: edge.targetNodeId.startsWith(prefix)
      ? edge.targetNodeId.slice(prefix.length)
      : edge.targetNodeId,
  };
}

describe("AC1 子图打包/展开", () => {
  test("AC1 打包中间 3 节点为 subworkflow，边界端口正确且 expand 还原节点/边集合等价", () => {
    const original: Workflow = {
      id: "ac1-wf",
      name: "ac1",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makePassNode("svA", "a_out"),
        countCmdNode("cmdA"),
        makePassNode("svB"),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "svA", targetPortId: "in" },
        { id: "e2", sourceNodeId: "svA", sourcePortId: "a_out", targetNodeId: "cmdA", targetPortId: "in" },
        { id: "e3", sourceNodeId: "cmdA", sourcePortId: "count", targetNodeId: "svB", targetPortId: "in" },
        { id: "e4", sourceNodeId: "svB", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const packed = packageSubgraph(original, ["svA", "cmdA", "svB"]);
    const subNode = packed.workflow.nodes.find((node) => node.id === packed.subNodeId);
    expect(subNode?.type).toBe("subworkflow");
    // 边界端口：入边生成 in_in+binding，出边生成 out_out；父图选中节点移除、边界边改指。
    expect(subNode?.inputs.some((port) => port.id === "in_in" && port.binding === "workflow:params:in")).toBe(true);
    expect(subNode?.outputs.some((port) => port.id === "out_out")).toBe(true);
    expect(packed.workflow.nodes).toHaveLength(3);
    expect(packed.workflow.edges.find((edge) => edge.targetNodeId === packed.subNodeId)?.targetPortId).toBe("in_in");
    expect(packed.workflow.edges.find((edge) => edge.sourceNodeId === packed.subNodeId)?.sourcePortId).toBe("out_out");
    // expand 还原：节点/边数量与集合等价（去前缀、忽略自动 __end）。
    const prefix = `${packed.subNodeId}__`;
    const restored = expandSubgraph(packed.workflow, packed.subNodeId);
    expect(restored.nodes).toHaveLength(original.nodes.length);
    expect(restored.edges).toHaveLength(original.edges.length);
    const originalNodeById = new Map(original.nodes.map((node) => [node.id, node]));
    for (const node of restored.nodes) {
      const normalized = normalizeNode(node, prefix);
      expect(originalNodeById.get(normalized.id)).toEqual(normalized);
    }
    const originalEdges = original.edges.map((edge) => JSON.stringify(edge));
    for (const edge of restored.edges) {
      expect(originalEdges).toContain(JSON.stringify(normalizeEdge(edge, prefix)));
    }
  });
});

describe("AC3 断点续跑（组合子工作流）", () => {
  test("AC3 制造断点后 resumeRun：start/sv 不重跑、subworkflow 重跑子图", async () => {
    // 子图 command 每次执行 append 一行：跨重启计数子图重跑次数。
    // 子引擎固定用全局 registry，只能用内置节点（command 而非自定义 countCmd）。
    const counterPath = join(TEMP_DIR, "ac3-counter.txt");
    const sub: Workflow = {
      id: "ac3-sub",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("cmd", "command", {
          command: "node",
          args: ["-e", "require('fs').appendFileSync(process.argv[1], 'x\\n')", counterPath],
          failOnNonZero: true,
        }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "ac3-wf",
      name: "ac3",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 1 }),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextStorePath("run") });
    const engine1 = new ExecutionEngine(parent, { runId: "ac3-run", persist: true, runStateStore: store });
    const r1 = await engine1.run();
    expect(r1.status).toBe("success");
    expect((await readFile(counterPath, "utf8")).split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    // 制造断点：sub/end 重置 Idle（模拟中断在 sub 前），start/sv 保持 Success。
    const snap = await store.getById("ac3-run");
    if (snap === undefined) throw new Error("expected run state");
    const modified: RunState = { ...snap, nodeStates: { ...snap.nodeStates, sub: "Idle", end: "Idle" } };
    await store.update(modified);
    const events: Array<{ nodeId: string; to: NodeStatus }> = [];
    const r2 = await resumeRun("ac3-run", {
      runStateStore: store,
      events: { onNodeStateChange: (info) => events.push({ nodeId: info.nodeId, to: info.to }) },
    });
    expect(r2.status).toBe("success");
    expect((await readFile(counterPath, "utf8")).split("\n").filter((line) => line.length > 0)).toHaveLength(2);
    const reran = new Set(events.map((entry) => entry.nodeId));
    expect(reran.has("start")).toBe(false);
    expect(reran.has("sv")).toBe(false);
    expect(reran.has("sub")).toBe(true);
    expect(reran.has("end")).toBe(true);
  });
});

describe("AC4 运行时编辑锁", () => {
  test("AC4 persist run 挂起中 isReadOnly=true，workflowSnapshot 深拷贝独立", async () => {
    const workflow: Workflow = {
      id: "ac4-wf",
      name: "ac4",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(workflow, {
      runId: "ac4-run",
      persist: true,
      runStateStore: new RunStateStore({ filePath: nextStorePath("run") }),
      humanTaskStore: new HumanTaskStore({ filePath: nextStorePath("human") }),
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("waiting");
    expect(engine.isReadOnly).toBe(true);
    // workflowSnapshot 深拷贝：修改返回对象不影响引擎内部 workflow。
    const snap = engine.workflowSnapshot;
    expect(snap).not.toBe(workflow);
    const mutable = JSON.parse(JSON.stringify(snap)) as {
      nodes: Array<{ id: string; params: Record<string, unknown> }>;
    };
    if (mutable.nodes[0] === undefined) {
      throw new Error("expected node");
    }
    mutable.nodes[0].params["evil"] = true;
    expect(engine.workflowSnapshot.nodes[0]?.params["evil"]).toBeUndefined();
  });
});

describe("AC5 草稿替换", () => {
  test("AC5 createDraft→改草稿→commitDraft 继承元信息，saveWorkflow/loadWorkflow 往返一致", async () => {
    const original: Workflow = {
      id: "ac5-wf",
      name: "ac5",
      version: "1.2.3",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 1 }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const draft = createDraft(original);
    const modifiedDraft: Draft = { ...draft, nodes: [...draft.nodes, makeNode("sv2", "setVariable", { target: "workflow:x", value: 2 })] };
    const committed = commitDraft(modifiedDraft, original);
    expect(committed.id).toBe("ac5-wf");
    expect(committed.name).toBe(original.name);
    expect(committed.version).toBe("1.2.3");
    expect(committed.draftOf).toBeUndefined();
    expect(committed.nodes.some((node) => node.id === "sv2")).toBe(true);
    expect(committed.nodes).toHaveLength(4);
    // 持久化往返：JSON 文件读写一致。
    const filePath = nextStorePath("wf");
    await saveWorkflow(filePath, committed);
    expect(await loadWorkflow(filePath)).toEqual(committed);
  });
});
