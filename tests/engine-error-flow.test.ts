// 引擎失败语义改造（v0.2.2 T3）：finally 链放行 + tryCatch 端口互斥 + progress 进度钩子。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext, INodeDefinition } from "../src/execution/types.js";
import { ExecutionEngine, type ExecutionResult } from "../src/execution/Engine.js";
import { isActiveIncoming, type EngineReadState } from "../src/execution/engine-util.js";
import type { Edge, Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import type { RunState } from "../src/runstate/types.js";

// ---------- 自定义节点定义 ----------

/** 记录节点：把 `type:id` 追加进 workflow:markerRuns，用于断言哪些节点真实执行。 */
const markerDef: INodeDefinition = {
  type: "marker",
  name: "marker",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    const runs = (ctx.get("workflow", "markerRuns") as string[] | undefined) ?? [];
    runs.push(`marker:${ctx.node.id}`);
    ctx.set("workflow", "markerRuns", runs);
    return { out: ctx.node.id };
  },
};

/** finally 节点：记录执行；params.mode === "fail" 时自身失败。 */
const finallyDef: INodeDefinition = {
  type: "finally",
  name: "finally",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    const runs = (ctx.get("workflow", "markerRuns") as string[] | undefined) ?? [];
    runs.push(`finally:${ctx.node.id}`);
    ctx.set("workflow", "markerRuns", runs);
    if (ctx.node.params["mode"] === "fail") {
      throw new Error(`finally exploded: ${ctx.node.id}`);
    }
    return { out: ctx.node.id };
  },
};

/** 失败节点：执行即抛错。 */
const boomDef: INodeDefinition = {
  type: "boom",
  name: "boom",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [],
  async execute(): Promise<Record<string, unknown>> {
    throw new Error("boom exploded");
  },
};

/** tryCatch 节点：v0.2.2 T4 已内置真实实现（tryCatchNode，params.body 子图执行 + 吞错），此处不再 mock。 */

/** 观察节点：读取 workflow:markerRuns 输出，由 end 占位边排到拓扑最后。 */
const captureDef: INodeDefinition = {
  type: "capture",
  name: "capture",
  inputs: [],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    return { out: ctx.getByPath("workflow:markerRuns") };
  },
};

const reg = new NodeRegistry();
for (const def of builtinNodes) {
  // T5 内置 finallyNode 与下方 T3 marker 版 finallyDef 同 type：跳过内置，保留自定义版（marker 记录 + mode 失败）。
  if (def.type === "finally") continue;
  reg.register(def);
}
reg.register(markerDef);
reg.register(finallyDef);
reg.register(boomDef);
reg.register(captureDef);

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = reg.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function captureNode(id: string): Node {
  return {
    id,
    type: "capture",
    name: id,
    params: {},
    inputs: [],
    outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  };
}

function markerRuns(result: ExecutionResult): string[] {
  const value = result.nodeOutputs["capture"]?.["out"];
  return Array.isArray(value) ? (value as string[]) : [];
}

// ---------- finally 链：失败后清理节点仍执行 ----------

describe("finally 链：失败后清理节点仍执行", () => {
  test("成功路径：A → finallyF → end，finally body 正常执行", async () => {
    const workflow: Workflow = {
      id: "finally-ok-wf",
      name: "finally-ok",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("m1", "marker"),
        makeNode("finallyF", "finally"),
        makeNode("end", "end"),
        captureNode("capture"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "m1", targetPortId: "in" },
        { id: "e2", sourceNodeId: "m1", sourcePortId: "out", targetNodeId: "finallyF", targetPortId: "in" },
        { id: "e3", sourceNodeId: "finallyF", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e4", sourceNodeId: "end", sourcePortId: "out", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("success");
    expect(markerRuns(result)).toEqual(["marker:m1", "finally:finallyF"]);
  });

  test("失败路径：A 失败 → finallyF 仍执行，结果 failed 且主错误保留", async () => {
    const workflow: Workflow = {
      id: "finally-fail-wf",
      name: "finally-fail",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("boom", "boom"),
        makeNode("finallyF", "finally"),
        makeNode("end", "end"),
        captureNode("capture"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "finallyF", targetPortId: "in" },
        { id: "e3", sourceNodeId: "finallyF", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e4", sourceNodeId: "end", sourcePortId: "out", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["boom"]).toBe("Failed");
    expect(result.nodeStates["finallyF"]).toBe("Success");
    expect(markerRuns(result)).toEqual(["finally:finallyF"]);
    expect(result.error).toContain("boom");
  });

  test("多个 finally 串行：A 失败 → finallyF1 → finallyF2 都执行", async () => {
    const workflow: Workflow = {
      id: "finally-chain-wf",
      name: "finally-chain",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("boom", "boom"),
        makeNode("finallyF1", "finally"),
        makeNode("finallyF2", "finally"),
        makeNode("end", "end"),
        captureNode("capture"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "finallyF1", targetPortId: "in" },
        { id: "e3", sourceNodeId: "finallyF1", sourcePortId: "out", targetNodeId: "finallyF2", targetPortId: "in" },
        { id: "e4", sourceNodeId: "finallyF2", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e5", sourceNodeId: "end", sourcePortId: "out", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("failed");
    expect(markerRuns(result)).toEqual(["finally:finallyF1", "finally:finallyF2"]);
    expect(result.error).toContain("boom");
  });

  test("finally 自身失败不阻断主错误：结果仍为 A 的错误", async () => {
    const workflow: Workflow = {
      id: "finally-self-fail-wf",
      name: "finally-self-fail",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("boom", "boom"),
        makeNode("finallyFail", "finally", { mode: "fail" }),
        makeNode("finallyF2", "finally"),
        makeNode("end", "end"),
        captureNode("capture"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "finallyFail", targetPortId: "in" },
        { id: "e3", sourceNodeId: "finallyFail", sourcePortId: "out", targetNodeId: "finallyF2", targetPortId: "in" },
        { id: "e4", sourceNodeId: "finallyF2", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e5", sourceNodeId: "end", sourcePortId: "out", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("failed");
    // 两个 finally 都执行过（自身失败的 finallyFail 也被放行执行后失败）。
    expect(markerRuns(result)).toEqual(["finally:finallyFail", "finally:finallyF2"]);
    expect(result.nodeStates["finallyFail"]).toBe("Failed");
    expect(result.nodeStates["finallyF2"]).toBe("Success");
    // 主错误保留为 boom 的错误，不被 finally 自身失败覆盖。
    expect(result.error).toContain("boom");
    expect(result.error).not.toContain("finally exploded");
  });

  test("finally 下游普通节点在失败后 Skipped", async () => {
    const workflow: Workflow = {
      id: "finally-plain-wf",
      name: "finally-plain",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("boom", "boom"),
        makeNode("finallyF", "finally"),
        makeNode("plain", "marker"),
        makeNode("end", "end"),
        captureNode("capture"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "finallyF", targetPortId: "in" },
        { id: "e3", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "plain", targetPortId: "in" },
        { id: "e4", sourceNodeId: "finallyF", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e5", sourceNodeId: "end", sourcePortId: "out", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["finallyF"]).toBe("Success");
    expect(result.nodeStates["plain"]).toBe("Skipped");
    expect(markerRuns(result)).toEqual(["finally:finallyF"]);
  });
});

// ---------- tryCatch 端口激活互斥 ----------

describe("tryCatch 端口激活互斥", () => {
  function makeTryCatchState(outputs: Record<string, unknown>): {
    state: EngineReadState;
    outEdge: Edge;
    catchEdge: Edge;
  } {
    const states = new Map<string, "Success">([["tc", "Success"]]);
    const outputsMap = new Map<string, Record<string, unknown>>([["tc", outputs]]);
    const nodeById = new Map<string, Node>([
      ["tc", { id: "tc", type: "tryCatch", name: "tc", params: {}, inputs: [], outputs: [] }],
      ["ok", { id: "ok", type: "marker", name: "ok", params: {}, inputs: [], outputs: [] }],
      ["err", { id: "err", type: "marker", name: "err", params: {}, inputs: [], outputs: [] }],
    ]);
    const outEdge: Edge = { id: "e-out", sourceNodeId: "tc", sourcePortId: "out", targetNodeId: "ok", targetPortId: "in" };
    const catchEdge: Edge = { id: "e-catch", sourceNodeId: "tc", sourcePortId: "catch", targetNodeId: "err", targetPortId: "in" };
    return { state: { states, outputs: outputsMap, nodeById }, outEdge, catchEdge };
  }

  test("单元级：正常分支输出 → out 激活 / catch 不激活", () => {
    const { state, outEdge, catchEdge } = makeTryCatchState({ out: "v", catch: undefined });
    expect(isActiveIncoming(outEdge, state)).toBe(true);
    expect(isActiveIncoming(catchEdge, state)).toBe(false);
  });

  test("单元级：异常分支输出 → out 不激活 / catch 激活", () => {
    const { state, outEdge, catchEdge } = makeTryCatchState({ out: undefined, catch: { message: "boom" } });
    expect(isActiveIncoming(outEdge, state)).toBe(false);
    expect(isActiveIncoming(catchEdge, state)).toBe(true);
  });

  test("集成级：正常模式 → 仅 out 分支下游执行", async () => {
    const body: Workflow = {
      id: "tc-body-ok",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "v" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const workflow: Workflow = {
      id: "tc-ok-wf",
      name: "tc-ok",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("tc", "tryCatch", { body }),
        makeNode("okBranch", "marker"),
        makeNode("catchBranch", "marker"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "tc", targetPortId: "in" },
        { id: "e2", sourceNodeId: "tc", sourcePortId: "out", targetNodeId: "okBranch", targetPortId: "in" },
        { id: "e3", sourceNodeId: "tc", sourcePortId: "catch", targetNodeId: "catchBranch", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["okBranch"]).toBe("Success");
    expect(result.nodeStates["catchBranch"]).toBe("Skipped");
  });

  test("集成级：异常模式 → 仅 catch 分支下游执行", async () => {
    const body: Workflow = {
      id: "tc-body-fail",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("boom", "boom"),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const workflow: Workflow = {
      id: "tc-err-wf",
      name: "tc-err",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("tc", "tryCatch", { body }),
        makeNode("okBranch", "marker"),
        makeNode("catchBranch", "marker"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "tc", targetPortId: "in" },
        { id: "e2", sourceNodeId: "tc", sourcePortId: "out", targetNodeId: "okBranch", targetPortId: "in" },
        { id: "e3", sourceNodeId: "tc", sourcePortId: "catch", targetNodeId: "catchBranch", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: reg }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["okBranch"]).toBe("Skipped");
    expect(result.nodeStates["catchBranch"]).toBe("Success");
  });
});

// ---------- progress 进度钩子 ----------

describe("progress 进度钩子", () => {
  test("persist 引擎中节点调用 ctx.progress → 触发断点持久化且快照含 node 级进度", async () => {
    const updates: RunState[] = [];
    const fakeStore: RunStateStoreLike = {
      create: async (run) => { updates.push(run); },
      update: async (run) => { updates.push(run); },
      getById: async () => undefined,
      list: async () => [],
      listByWorkflow: async () => [],
    };
    const progressDef: INodeDefinition = {
      type: "progressNode",
      name: "progressNode",
      inputs: [],
      outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
      async execute(ctx: NodeExecutionContext) {
        // 子图容器（loop）模式：进度写入 node 级上下文后调用 progress 钩子。
        ctx.set("node:pn", "loopProgress", 2);
        await ctx.progress?.({ step: 2, total: 3 });
        return { out: "ok" };
      },
    };
    const progressReg = new NodeRegistry();
    for (const def of builtinNodes) progressReg.register(def);
    progressReg.register(progressDef);
    const workflow: Workflow = {
      id: "progress-wf",
      name: "progress",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        { id: "pn", type: "progressNode", name: "pn", params: {}, inputs: [], outputs: [] },
      ],
      edges: [],
    };
    const engine = new ExecutionEngine(workflow, {
      registry: progressReg,
      runId: "progress-run",
      persist: true,
      runStateStore: fakeStore,
    });
    const result = await engine.run();
    expect(result.status).toBe("success");
    // 节点执行期 progress 触发过落盘，且该快照含 node:pn 级进度标记。
    const withProgress = updates.filter(
      (run) => (run.contextSnapshot.node["node:pn"]?.["loopProgress"] as number | undefined) === 2,
    );
    expect(withProgress.length).toBeGreaterThan(0);
    // 最终状态为 success。
    expect(updates[updates.length - 1]?.status).toBe("success");
  });
});
