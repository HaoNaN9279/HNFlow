// 图模型 + 图校验单测（AC1 支撑）。
import { describe, expect, test } from "bun:test";
import type {
  Edge,
  Node,
  Port,
  PortDirection,
  PortType,
  Workflow,
} from "../src/model/types.js";
import { detectCycle, validatePortTypes, validateWorkflow } from "../src/model/validate.js";
import { registry } from "../src/nodes/registry.js";

function makePort(
  id: string,
  name: string,
  type: PortType,
  direction: PortDirection,
  binding?: string,
): Port {
  return {
    id,
    name,
    type,
    direction,
    ...(binding === undefined ? {} : { binding }),
  };
}

function makeNode(
  id: string,
  type: string,
  opts: {
    readonly inputs?: readonly Port[];
    readonly outputs?: readonly Port[];
    readonly params?: Readonly<Record<string, unknown>>;
  } = {},
): Node {
  const def = registry.get(type);
  return {
    id,
    type,
    name: id,
    params: opts.params ?? {},
    inputs: opts.inputs ?? def.inputs,
    outputs: opts.outputs ?? def.outputs,
  };
}

function makeWorkflow(
  nodes: readonly Node[],
  edges: readonly Edge[],
  globalVariables?: Readonly<Record<string, unknown>>,
): Workflow {
  return {
    id: "wf",
    name: "wf",
    version: "0.1.0",
    nodes,
    edges,
    ...(globalVariables === undefined ? {} : { globalVariables }),
  };
}

function chainEdges(ids: readonly string[]): Edge[] {
  return ids.slice(0, -1).map((source, index) => {
    const target = ids[index + 1];
    if (target === undefined) throw new Error("chain edges: target missing");
    return {
      id: `e${index}`,
      sourceNodeId: source,
      sourcePortId: "out",
      targetNodeId: target,
      targetPortId: "in",
    };
  });
}

describe("模型类型构造", () => {
  test("Node/Edge/Port/Workflow 对象可构造", () => {
    const port: Port = {
      id: "in",
      name: "data",
      type: "any",
      direction: "in",
      binding: "workflow:x",
    };
    const node: Node = {
      id: "a",
      type: "start",
      name: "开始",
      params: {},
      inputs: [],
      outputs: [port],
      position: { x: 0, y: 0 },
    };
    const edge: Edge = {
      id: "e1",
      sourceNodeId: "a",
      sourcePortId: "data",
      targetNodeId: "b",
      targetPortId: "in",
    };
    const workflow: Workflow = {
      id: "wf",
      name: "wf",
      version: "0.1.0",
      nodes: [node],
      edges: [edge],
      globalVariables: { k: 1 },
    };
    expect(workflow.nodes[0]).toBe(node);
    expect(workflow.edges[0]).toBe(edge);
    expect(workflow.globalVariables).toEqual({ k: 1 });
    expect(node.outputs[0]).toBe(port);
  });
});

describe("detectCycle 环检测", () => {
  test("链状 a→b→c 无环", () => {
    const wf = makeWorkflow(
      [
        makeNode("a", "start"),
        makeNode("b", "setVariable"),
        makeNode("c", "setVariable"),
      ],
      chainEdges(["a", "b", "c"]),
    );
    expect(detectCycle(wf)).toEqual({ hasCycle: false, path: [] });
  });

  test("a→b→c→a 环路径", () => {
    const wf = makeWorkflow(
      [
        makeNode("a", "start"),
        makeNode("b", "setVariable"),
        makeNode("c", "setVariable"),
      ],
      [
        ...chainEdges(["a", "b", "c"]),
        { id: "e2", sourceNodeId: "c", sourcePortId: "out", targetNodeId: "a", targetPortId: "in" },
      ],
    );
    expect(detectCycle(wf)).toEqual({ hasCycle: true, path: ["a", "b", "c", "a"] });
  });

  test("自环 a→a", () => {
    const wf = makeWorkflow([makeNode("a", "start")], [
      { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "a", targetPortId: "in" },
    ]);
    expect(detectCycle(wf)).toEqual({ hasCycle: true, path: ["a", "a"] });
  });

  test("空图无环", () => {
    expect(detectCycle(makeWorkflow([], []))).toEqual({ hasCycle: false, path: [] });
  });
});

describe("validatePortTypes 端口类型匹配", () => {
  function twoNodeWorkflow(sourcePort: Port, targetPort: Port): Workflow {
    return makeWorkflow(
      [
        makeNode("a", "start", { outputs: [sourcePort] }),
        makeNode("b", "end", { inputs: [targetPort] }),
      ],
      [
        { id: "e1", sourceNodeId: "a", sourcePortId: "out", targetNodeId: "b", targetPortId: "in" },
      ],
    );
  }

  test("string→number 报错", () => {
    const errors = validatePortTypes(
      twoNodeWorkflow(makePort("out", "out", "string", "out"), makePort("in", "in", "number", "in")),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("type mismatch");
  });

  test("any→string 通过", () => {
    const errors = validatePortTypes(
      twoNodeWorkflow(makePort("out", "out", "any", "out"), makePort("in", "in", "string", "in")),
    );
    expect(errors).toEqual([]);
  });

  test("string→string 通过", () => {
    const errors = validatePortTypes(
      twoNodeWorkflow(makePort("out", "out", "string", "out"), makePort("in", "in", "string", "in")),
    );
    expect(errors).toEqual([]);
  });
});

describe("validateWorkflow 综合校验", () => {
  test("正常无环图 ok", () => {
    const wf = makeWorkflow([makeNode("a", "start"), makeNode("b", "end")], [
      { id: "e0", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "b", targetPortId: "in" },
    ]);
    expect(validateWorkflow(wf)).toEqual({ ok: true });
  });

  test("边引用不存在节点报错", () => {
    const wf = makeWorkflow([makeNode("a", "start"), makeNode("b", "end")], [
      { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "ghost", targetPortId: "in" },
    ]);
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("目标节点");
    }
  });

  test("边引用不存在端口报错", () => {
    const wf = makeWorkflow([makeNode("a", "start"), makeNode("b", "end")], [
      { id: "e1", sourceNodeId: "a", sourcePortId: "nope", targetNodeId: "b", targetPortId: "in" },
    ]);
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("源端口");
    }
  });

  test("有环报错", () => {
    const wf = makeWorkflow(
      [makeNode("a", "start"), makeNode("b", "setVariable"), makeNode("c", "setVariable")],
      [
        ...chainEdges(["a", "b", "c"]),
        { id: "e2", sourceNodeId: "c", sourcePortId: "out", targetNodeId: "a", targetPortId: "in" },
      ],
    );
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("cycle detected");
    }
  });
});
