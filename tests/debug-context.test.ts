// 分支上下文快照（T4）测试：loop 迭代 / parallel 分支的 workflow 变量快照落 node 级上下文
// （键约定 node:<id>:branch:<分支id>，调试 CLI 据此查看分支作用域）；
// 验证快照只写 node 级、不污染父 workflow 作用域、既有合并语义不变、独立 NodeRegistry 可用。
import { describe, expect, test } from "bun:test";
import { ExecutionEngine, type ExecutionResult } from "../src/execution/Engine.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import type { RunState } from "../src/runstate/types.js";

let fileCounter = 0;

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeLoopNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("loop");
  return { id, type: "loop", name: "循环", params, inputs: def.inputs, outputs: def.outputs };
}

function makeParallelNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("parallel");
  return { id, type: "parallel", name: "并行分支", params, inputs: def.inputs, outputs: def.outputs };
}

/** 迭代 body：setVariable 把迭代变量组合写 endInput → endResult。 */
function interpolateBody(): Workflow {
  return {
    id: "loop-body",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", {
        target: "workflow:endInput",
        value: "idx-${workflow:loopIndex}-item-${workflow:loopItem}",
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** parent：start → loop → end，loop 输出 results 连 end。 */
function loopWorkflow(id: string, loopParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id,
    name: "parent",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeLoopNode("loop", loopParams),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 分支：setVariable 独立修改 x + 写 endInput → end。 */
function branchWorkflow(branchId: string, x: string, endInput: string): Workflow {
  return {
    id: `branch-${branchId}`,
    name: branchId,
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv1", "setVariable", { target: "workflow:x", value: x }),
      makeNode("sv2", "setVariable", { target: "workflow:endInput", value: endInput }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** parent：start → par → end，par 输出 results 连 end。 */
function parallelWorkflow(id: string, branches: readonly unknown[]): Workflow {
  return {
    id,
    name: "parent",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeParallelNode("par", { branches }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** persist 运行并取终态 contextSnapshot（照 loop-node.test.ts 的 FakeRunStateStore 模式）。 */
async function runWithSnapshot(
  wf: Workflow,
  registryOverride?: NodeRegistry,
): Promise<{ result: ExecutionResult; snapshot: RunState["contextSnapshot"] }> {
  const fake = new FakeRunStateStore();
  const engine = new ExecutionEngine(wf, {
    runId: `debug-ctx-${fileCounter++}-${Date.now()}`,
    persist: true,
    runStateStore: fake,
    ...(registryOverride === undefined ? {} : { registry: registryOverride }),
  });
  const result = await engine.run();
  const state = await fake.getById(engine.runId);
  if (state === undefined) {
    throw new Error("expected run state");
  }
  return { result, snapshot: state.contextSnapshot };
}

describe("loop 分支上下文快照", () => {
  test("3 次迭代：node:loop:branch:0/1/2 各含当次迭代变量（loopIndex/loopItem 递增）", async () => {
    const { result, snapshot } = await runWithSnapshot(
      loopWorkflow("loop-snap", { items: [10, 20, 30], body: interpolateBody() }),
    );
    expect(result.status).toBe("success");
    const scope = snapshot.node["node:loop"];
    expect(scope?.["branch:0"]).toMatchObject({ loopIndex: 0, loopItem: 10, loopCount: 3 });
    expect(scope?.["branch:1"]).toMatchObject({ loopIndex: 1, loopItem: 20, loopCount: 3 });
    expect(scope?.["branch:2"]).toMatchObject({ loopIndex: 2, loopItem: 30, loopCount: 3 });
    // 既有行为回归：results 合并照旧。
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-10",
      "idx-1-item-20",
      "idx-2-item-30",
    ]);
  });

  test("快照写 node 级：父 workflow 变量保持原值，workflow 作用域无 branch 键", async () => {
    const wf: Workflow = {
      id: "loop-snap-pure",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 42 }),
        makeLoopNode("loop", { items: 2, body: interpolateBody() }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const { result, snapshot } = await runWithSnapshot(wf);
    expect(result.status).toBe("success");
    expect(snapshot.workflow["x"]).toBe(42);
    expect(snapshot.workflow["branch:0"]).toBeUndefined();
    expect(snapshot.node["node:loop"]?.["branch:0"]).toBeDefined();
  });
});

describe("parallel 分支上下文快照", () => {
  test("两分支独立修改：branch:b1/b2 的 x 各为分支值且互不相同；results 合并照旧", async () => {
    const wf = parallelWorkflow("par-snap", [
      { id: "b1", workflow: branchWorkflow("b1", "from-b1", "B1") },
      { id: "b2", workflow: branchWorkflow("b2", "from-b2", "B2") },
    ]);
    const { result, snapshot } = await runWithSnapshot(wf);
    expect(result.status).toBe("success");
    const scope = snapshot.node["node:par"];
    const b1 = scope?.["branch:b1"] as Record<string, unknown> | undefined;
    const b2 = scope?.["branch:b2"] as Record<string, unknown> | undefined;
    expect(b1?.["x"]).toBe("from-b1");
    expect(b2?.["x"]).toBe("from-b2");
    expect(b1?.["x"]).not.toBe(b2?.["x"]);
    // 快照只写 node 级：父 workflow 作用域不出现 branch:* 键。
    expect(snapshot.workflow["branch:b1"]).toBeUndefined();
    expect(snapshot.workflow["branch:b2"]).toBeUndefined();
    // 既有行为回归：results 合并照旧（replace 模式，声明顺序 b2 最后写回父 x）。
    expect(result.nodeOutputs["par"]?.["results"]).toEqual({ b1: "B1", b2: "B2" });
    expect(snapshot.workflow["x"]).toBe("from-b2");
  });
});

describe("独立 NodeRegistry", () => {
  test("自定义 registry 实例（不注册全局）执行 loop：快照照常写入", async () => {
    const reg = new NodeRegistry();
    for (const def of builtinNodes) reg.register(def);
    const { result, snapshot } = await runWithSnapshot(
      loopWorkflow("loop-reg", { items: ["a"], body: interpolateBody() }),
      reg,
    );
    expect(result.status).toBe("success");
    expect(snapshot.node["node:loop"]?.["branch:0"]).toMatchObject({ loopItem: "a" });
  });
});

/** 内存版 RunState store：persist 断言用。 */
class FakeRunStateStore implements RunStateStoreLike {
  private readonly states = new Map<string, RunState>();

  async create(run: RunState): Promise<void> {
    this.states.set(run.runId, run);
  }

  async update(run: RunState): Promise<void> {
    this.states.set(run.runId, run);
  }

  async getById(runId: string): Promise<RunState | undefined> {
    return this.states.get(runId);
  }

  async list(): Promise<RunState[]> {
    return [...this.states.values()];
  }

  async listByWorkflow(workflowId: string): Promise<RunState[]> {
    return [...this.states.values()].filter((run) => run.workflowId === workflowId);
  }
}
