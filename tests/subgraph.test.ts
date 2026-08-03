// 子图变换 API 单测：package→expand 往返、边界自动端口、多出口聚合、依赖快照、非法选择、嵌套序列化。
import { describe, expect, test } from "bun:test";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { fromJSON, toJSON } from "../src/serialization/index.js";
import {
  expandSubgraph,
  InvalidSubgraphSelectionError,
  packageSubgraph,
} from "../src/subgraph/index.js";

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
    readonly position?: { x: number; y: number };
    readonly subworkflow?: Workflow;
  } = {},
): Node {
  const def = registrySafe(type);
  return {
    id,
    type,
    name: id,
    params: opts.params ?? {},
    inputs: opts.inputs ?? def?.inputs ?? [],
    outputs: opts.outputs ?? def?.outputs ?? [],
    ...(opts.position === undefined ? {} : { position: opts.position }),
    ...(opts.subworkflow === undefined ? {} : { subworkflow: opts.subworkflow }),
  };
}

function registrySafe(type: string) {
  return registry.has(type) ? registry.get(type) : undefined;
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

// 自定义输出节点：execute 写 workflow 变量并返回输出端口值。
function makeEmitDef(): INodeDefinition {
  return {
    type: "emit",
    name: "emit",
    inputs: [],
    outputs: [makePort("out", "out", "any", "out")],
    async execute(ctx) {
      ctx.setByPath(String(ctx.node.params["target"]), ctx.node.params["value"]);
      return { out: ctx.node.params["value"] };
    },
  };
}

/** 往返测试：去掉子图 id 前缀，忽略 __end 自动节点。 */
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

describe("packageSubgraph 非法选择", () => {
  const wf = makeWorkflow(
    [makeNode("a", "start"), makeNode("b", "end")],
    [
      { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "b", targetPortId: "in" },
    ],
  );

  test("空集抛 InvalidSubgraphSelectionError", () => {
    expect(() => packageSubgraph(wf, [])).toThrow(InvalidSubgraphSelectionError);
  });

  test("单节点抛 InvalidSubgraphSelectionError", () => {
    expect(() => packageSubgraph(wf, ["a"])).toThrow(InvalidSubgraphSelectionError);
  });

  test("id 不在图中抛 InvalidSubgraphSelectionError", () => {
    expect(() => packageSubgraph(wf, ["a", "ghost"])).toThrow(InvalidSubgraphSelectionError);
  });
});

describe("expandSubgraph 非法选择", () => {
  test("节点不存在抛 InvalidSubgraphSelectionError", () => {
    const wf = makeWorkflow([makeNode("a", "start")], []);
    expect(() => expandSubgraph(wf, "ghost")).toThrow(InvalidSubgraphSelectionError);
  });

  test("节点非 subworkflow 类型抛 InvalidSubgraphSelectionError", () => {
    const wf = makeWorkflow([makeNode("a", "start")], []);
    expect(() => expandSubgraph(wf, "a")).toThrow(InvalidSubgraphSelectionError);
  });
});

describe("package→expand 往返", () => {
  function buildGraph(): Workflow {
    return makeWorkflow(
      [
        makeNode("a", "start"),
        makeNode("b", "mid", {
          inputs: [makePort("b", "入", "any", "in")],
          outputs: [makePort("b_out", "出", "any", "out")],
        }),
        makeNode("c", "mid", {
          inputs: [makePort("c_in", "入", "any", "in")],
          outputs: [makePort("c", "出", "any", "out")],
        }),
        makeNode("x", "start"),
        makeNode("y", "sink", { inputs: [makePort("in", "入", "any", "in")] }),
      ],
      [
        { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "b", targetPortId: "b" },
        { id: "e2", sourceNodeId: "x", sourcePortId: "data", targetNodeId: "b", targetPortId: "b" },
        { id: "e3", sourceNodeId: "b", sourcePortId: "b_out", targetNodeId: "c", targetPortId: "c_in" },
        { id: "e4", sourceNodeId: "c", sourcePortId: "c", targetNodeId: "y", targetPortId: "in" },
      ],
    );
  }

  test("打包 B+C 后 expand 还原节点/边集合等价", () => {
    const original = buildGraph();
    const packed = packageSubgraph(original, ["b", "c"]);
    const prefix = `${packed.subNodeId}__`;
    const restored = expandSubgraph(packed.workflow, packed.subNodeId);

    expect(packed.subWorkflow.nodes.some((node) => node.id === "__end")).toBe(true);
    expect(restored.nodes).toHaveLength(original.nodes.length);
    expect(restored.edges).toHaveLength(original.edges.length);

    const originalById = new Map(original.nodes.map((node) => [node.id, node]));
    for (const node of restored.nodes) {
      const normalized = normalizeNode(node, prefix);
      const expected = originalById.get(normalized.id);
      if (expected === undefined) throw new Error(`原图缺少节点: ${normalized.id}`);
      expect(normalized).toEqual(expected);
    }    const originalEdgeSet = original.edges.map((edge) => JSON.stringify(edge));
    for (const edge of restored.edges) {
      expect(originalEdgeSet).toContain(JSON.stringify(normalizeEdge(edge, prefix)));
    }
  });
});

describe("边界边自动端口", () => {
  test("外部入边生成 in_b 端口、出边生成 out_c 端口且 binding/type 正确", () => {
    const original = makeWorkflow(
      [
        makeNode("a", "start"),
        makeNode("b", "mid", {
          inputs: [makePort("b", "入", "string", "in")],
          outputs: [makePort("b_out", "出", "any", "out")],
        }),
        makeNode("c", "mid", {
          inputs: [makePort("c_in", "入", "any", "in")],
          outputs: [makePort("c", "出", "string", "out")],
        }),
        makeNode("x", "start"),
        makeNode("y", "sink", { inputs: [makePort("in", "入", "any", "in")] }),
      ],
      [
        { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "b", targetPortId: "b" },
        { id: "e2", sourceNodeId: "x", sourcePortId: "data", targetNodeId: "b", targetPortId: "b" },
        { id: "e3", sourceNodeId: "b", sourcePortId: "b_out", targetNodeId: "c", targetPortId: "c_in" },
        { id: "e4", sourceNodeId: "c", sourcePortId: "c", targetNodeId: "y", targetPortId: "in" },
      ],
    );
    const packed = packageSubgraph(original, ["b", "c"]);
    const subNode = packed.workflow.nodes.find((node) => node.id === packed.subNodeId);
    if (subNode === undefined) throw new Error("sub node missing");

    const inPort = subNode.inputs.find((port) => port.id === "in_b");
    expect(inPort).toEqual({
      id: "in_b",
      name: "入",
      type: "string",
      direction: "in",
      binding: "workflow:params:b",
    });
    const outPort = subNode.outputs.find((port) => port.id === "out_c");
    expect(outPort).toEqual({ id: "out_c", name: "出", type: "string", direction: "out" });
    // 父图外部边改指子节点端口。
    const incoming = packed.workflow.edges.filter(
      (edge) => edge.targetNodeId === packed.subNodeId && edge.targetPortId === "in_b",
    );
    expect(incoming).toHaveLength(1);
    const outgoing = packed.workflow.edges.find(
      (edge) => edge.sourceNodeId === packed.subNodeId && edge.sourcePortId === "out_c",
    );
    expect(outgoing).toEqual({ id: "e4", sourceNodeId: packed.subNodeId, sourcePortId: "out_c", targetNodeId: "y", targetPortId: "in" });
  });
});

describe("多出口聚合", () => {
  test("选中 2 个无出边节点 → 子图含 __end 且 2 条入边；执行后 endResult 为聚合数组", async () => {
    const emitDef = makeEmitDef();
    const captureDef: INodeDefinition = {
      type: "capture",
      name: "capture",
      inputs: [makePort("in", "入", "any", "in")],
      outputs: [makePort("out", "出", "any", "out")],
      async execute(ctx: NodeExecutionContext) {
        return { out: ctx.getByPath("workflow:endResult") };
      },
    };
    const subRegistry = new NodeRegistry();
    for (const def of builtinNodes) subRegistry.register(def);
    subRegistry.register(emitDef);
    subRegistry.register(captureDef);

    const original = makeWorkflow(
      [
        makeNode("p1", "emit", {
          params: { target: "workflow:r1", value: "v1" },
          outputs: [makePort("out", "出", "any", "out")],
        }),
        makeNode("p2", "emit", {
          params: { target: "workflow:r2", value: "v2" },
          outputs: [makePort("out", "出", "any", "out")],
        }),
      ],
      [],
    );
    const packed = packageSubgraph(original, ["p1", "p2"]);
    const sub = packed.subWorkflow;

    const endNode = sub.nodes.find((node) => node.id === "__end");
    expect(endNode).toBeDefined();
    expect(sub.nodes.filter((node) => node.id === "__end")).toHaveLength(1);
    const endInEdges = sub.edges.filter((edge) => edge.targetNodeId === "__end");
    expect(endInEdges).toHaveLength(2);

    // 追加 capture 节点读取 endResult，保证 end 后执行。
    const captureNode = makeNode("capture", "capture", {
      inputs: [makePort("in", "入", "any", "in")],
      outputs: [makePort("out", "出", "any", "out")],
    });
    const runWorkflow: Workflow = {
      id: "run",
      name: "run",
      version: "0.1.0",
      nodes: [...sub.nodes, captureNode],
      edges: [
        ...sub.edges,
        {
          id: "cap-edge",
          sourceNodeId: "__end",
          sourcePortId: "out",
          targetNodeId: "capture",
          targetPortId: "in",
        },
      ],
    };
    const result = await new ExecutionEngine(runWorkflow, { registry: subRegistry }).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["capture"]?.["out"]).toEqual(["v1", "v2"]);
  });
});

describe("依赖快照", () => {
  test("params.dependencies 为子图节点 type 去重集合", () => {
    const original = makeWorkflow(
      [
        makeNode("a", "start"),
        makeNode("s1", "setVariable", { params: { target: "workflow:x", value: 1 } }),
        makeNode("s2", "setVariable", { params: { target: "workflow:y", value: 2 } }),
      ],
      [
        { id: "e1", sourceNodeId: "a", sourcePortId: "data", targetNodeId: "s1", targetPortId: "in" },
        { id: "e2", sourceNodeId: "s1", sourcePortId: "out", targetNodeId: "s2", targetPortId: "in" },
      ],
    );
    const packed = packageSubgraph(original, ["s1", "s2"]);
    const subNode = packed.workflow.nodes.find((node) => node.id === packed.subNodeId);
    if (subNode === undefined) throw new Error("sub node missing");
    const dependencies = subNode.params["dependencies"];
    expect(dependencies).toEqual(["setVariable", "end"]);
  });
});

describe("嵌套 2 层 subworkflow 序列化", () => {
  test("toJSON/fromJSON 往返一致", () => {
    const inner: Workflow = makeWorkflow(
      [makeNode("inner-a", "start"), makeNode("inner-b", "end")],
      [
        {
          id: "e1",
          sourceNodeId: "inner-a",
          sourcePortId: "data",
          targetNodeId: "inner-b",
          targetPortId: "in",
        },
      ],
    );
    const mid: Workflow = makeWorkflow(
      [
        makeNode("mid-a", "mid", { subworkflow: inner, outputs: [makePort("out", "出", "any", "out")] }),
      ],
      [],
    );
    const outer: Workflow = makeWorkflow(
      [
        makeNode("outer-a", "mid", { subworkflow: mid, outputs: [makePort("out", "出", "any", "out")] }),
      ],
      [],
    );

    const json = toJSON(outer);
    const restored = fromJSON(JSON.parse(JSON.stringify(json)));
    expect(restored).toEqual(outer);
  });
});
