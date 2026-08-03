// 执行引擎集成测试（AC2 + AC3 + AC4）。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext, INodeDefinition } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { NodeStatus } from "../src/execution/NodeState.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

// 观察节点：无输入端口，靠来自 end 的占位边排到拓扑最后，读取 workflow:result 输出。
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

const captureDef: INodeDefinition = {
  type: "capture",
  name: "capture",
  inputs: [],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    return { out: ctx.getByPath("workflow:result") };
  },
};

// 绑定槽观察节点：输入端口带 binding，验证上游输出写入 binding 槽。
function captureInNode(id: string): Node {
  return {
    id,
    type: "captureIn",
    name: id,
    params: {},
    inputs: [{ id: "in", name: "in", type: "any", direction: "in", binding: "workflow:captureIn" }],
    outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  };
}

const captureInDef: INodeDefinition = {
  type: "captureIn",
  name: "captureIn",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in", binding: "workflow:captureIn" }],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    return { out: ctx.getByPath("workflow:captureIn") };
  },
};

const boomDef: INodeDefinition = {
  type: "boom",
  name: "boom",
  inputs: [],
  outputs: [],
  async execute(): Promise<Record<string, unknown>> {
    throw new Error("boom exploded");
  },
};

const customRegistry = new NodeRegistry();
for (const def of builtinNodes) customRegistry.register(def);
customRegistry.register(captureDef);
customRegistry.register(captureInDef);

const boomRegistry = new NodeRegistry();
for (const def of builtinNodes) boomRegistry.register(def);
boomRegistry.register(boomDef);

describe("AC2 串行执行", () => {
  test("start→setVariable→end 全 Success 且事件序列完整", async () => {
    const workflow: Workflow = {
      id: "serial-wf",
      name: "serial",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:msg", value: "hello" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "sv", targetPortId: "in" },
        { id: "e2", sourceNodeId: "sv", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const stateChanges: Array<{ nodeId: string; from: NodeStatus; to: NodeStatus }> = [];
    const engine = new ExecutionEngine(workflow, {
      events: {
        onNodeStateChange: (info) => {
          stateChanges.push(info);
        },
      },
    });
    const result = await engine.run();

    expect(result.status).toBe("success");
    expect(result.nodeStates).toEqual({ start: "Success", sv: "Success", end: "Success" });
    // 每节点一次 Idle→Running + 一次 Running→Success：3 节点共 6 条。
    expect(stateChanges).toHaveLength(6);
    for (const nodeId of ["start", "sv", "end"]) {
      const nodeEvents = stateChanges.filter((change) => change.nodeId === nodeId);
      expect(nodeEvents).toHaveLength(2);
      expect(nodeEvents[0]).toEqual({ nodeId, from: "Idle", to: "Running" });
      expect(nodeEvents[1]).toEqual({ nodeId, from: "Running", to: "Success" });
    }
  });
});

describe("AC3 条件分支", () => {
  function makeBranchWorkflow(age: number): Workflow {
    return {
      id: "branch-wf",
      name: "branch",
      version: "0.1.0",
      globalVariables: { age },
      nodes: [
        makeNode("start", "start"),
        makeNode("if", "ifElse", { condition: { variable: "global:age", op: "gt", value: 18 } }),
        makeNode("adult", "setVariable", { target: "workflow:result", value: "adult" }),
        makeNode("minor", "setVariable", { target: "workflow:result", value: "minor" }),
        makeNode("end", "end"),
        captureNode("capture"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "if", targetPortId: "in" },
        { id: "e2", sourceNodeId: "if", sourcePortId: "true", targetNodeId: "adult", targetPortId: "in" },
        { id: "e3", sourceNodeId: "if", sourcePortId: "false", targetNodeId: "minor", targetPortId: "in" },
        { id: "e4", sourceNodeId: "adult", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e5", sourceNodeId: "minor", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
        { id: "e6", sourceNodeId: "end", sourcePortId: "out", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
  }

  test("age=30 → adult Success / minor Skipped / end Success / result=adult", async () => {
    const result = await new ExecutionEngine(makeBranchWorkflow(30), {
      registry: customRegistry,
    }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["adult"]).toBe("Success");
    expect(result.nodeStates["minor"]).toBe("Skipped");
    expect(result.nodeStates["end"]).toBe("Success");
    expect(result.nodeOutputs["capture"]?.["out"]).toBe("adult");
  });

  test("age=10 → adult Skipped / minor Success / end Success / result=minor", async () => {
    const result = await new ExecutionEngine(makeBranchWorkflow(10), {
      registry: customRegistry,
    }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["adult"]).toBe("Skipped");
    expect(result.nodeStates["minor"]).toBe("Success");
    expect(result.nodeStates["end"]).toBe("Success");
    expect(result.nodeOutputs["capture"]?.["out"]).toBe("minor");
  });

  test("单分支（仅 true 端口→end，age=10）→ end Skipped", async () => {
    const workflow: Workflow = {
      id: "single-branch",
      name: "single-branch",
      version: "0.1.0",
      globalVariables: { age: 10 },
      nodes: [
        makeNode("start", "start"),
        makeNode("if", "ifElse", { condition: { variable: "global:age", op: "gt", value: 18 } }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "if", targetPortId: "in" },
        { id: "e2", sourceNodeId: "if", sourcePortId: "true", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["if"]).toBe("Success");
    expect(result.nodeStates["end"]).toBe("Skipped");
  });
});

describe("AC4 端口读写", () => {
  test("start 输出（含 globalVariables 快照）流向 end", async () => {
    const workflow: Workflow = {
      id: "port-wf",
      name: "port",
      version: "0.1.0",
      globalVariables: { name: "hnflow", tier: "core" },
      nodes: [makeNode("start", "start"), makeNode("end", "end")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["end"]).toBe("Success");
    expect(result.nodeOutputs["start"]?.["data"]).toEqual({ name: "hnflow", tier: "core" });
  });

  test("上游输出经边写入下游输入端口 binding 槽，下游可读", async () => {
    const workflow: Workflow = {
      id: "bind-wf",
      name: "bind",
      version: "0.1.0",
      globalVariables: { name: "hnflow", tier: "core" },
      nodes: [makeNode("start", "start"), captureInNode("capture")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "capture", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, { registry: customRegistry }).run();
    expect(result.nodeStates["capture"]).toBe("Success");
    expect(result.nodeOutputs["capture"]?.["out"]).toEqual({ name: "hnflow", tier: "core" });
  });
});

describe("执行失败与边界", () => {
  test("节点失败 → 自身 Failed / 后续 Idle / status failed / error 含节点名", async () => {
    const workflow: Workflow = {
      id: "boom-wf",
      name: "boom",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        { id: "boom", type: "boom", name: "boom", params: {}, inputs: [], outputs: [] },
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    let onErrorCalled = false;
    const result = await new ExecutionEngine(workflow, {
      registry: boomRegistry,
      events: { onError: () => (onErrorCalled = true) },
    }).run();

    expect(result.status).toBe("failed");
    expect(result.nodeStates).toEqual({ start: "Success", boom: "Failed", end: "Idle" });
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("boom");
    expect(onErrorCalled).toBe(true);
  });

  test("带环工作流 run() 抛错含环路径", async () => {
    const workflow: Workflow = {
      id: "cycle-wf",
      name: "cycle",
      version: "0.1.0",
      nodes: [
        makeNode("a", "start"),
        makeNode("b", "setVariable", { target: "workflow:x", value: 1 }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "b", targetPortId: "in" },
        { id: "e2", sourceNodeId: "b", sourcePortId: "out", targetNodeId: "a", targetPortId: "in" },
      ],
    };
    await expect(new ExecutionEngine(workflow).run()).rejects.toThrow(
      "workflow cycle detected: a -> b -> a",
    );
  });

  test("空 nodes 返回 success 空状态", async () => {
    const workflow: Workflow = {
      id: "empty-wf",
      name: "empty",
      version: "0.1.0",
      nodes: [],
      edges: [],
    };
    const result = await new ExecutionEngine(workflow).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates).toEqual({});
    expect(result.nodeOutputs).toEqual({});
  });
});
