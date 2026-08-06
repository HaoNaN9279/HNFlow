// 编辑器图模型中间层单测：结构转换、嵌套递归、position 默认值、往返一致性、非法输入抛错。
import { describe, expect, test } from "bun:test";
import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import {
  fromEditorGraph,
  toEditorGraph,
  type EditorGraph,
} from "../src/editing/editor-graph.js";

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
    readonly position?: { readonly x: number; readonly y: number };
    readonly subworkflow?: Workflow;
  } = {},
): Node {
  // 非内置类型用空端口，避免 registry.get 抛 UnknownNodeTypeError。
  const def = registry.has(type) ? registry.get(type) : undefined;
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

function makeWorkflow(
  nodes: readonly Node[],
  edges: readonly Edge[],
  id = "wf",
  name = "wf",
  version = "0.1.0",
): Workflow {
  return { id, name, version, nodes, edges };
}

/** start → end 一条边（start.data 与 end.in 均为 any，端口类型兼容）。 */
function makeStartEndEdge(): Edge {
  return {
    id: "e1",
    sourceNodeId: "a",
    sourcePortId: "data",
    targetNodeId: "b",
    targetPortId: "in",
  };
}

describe("toEditorGraph 简单工作流", () => {
  test("结构正确：节点、边、entryNodeId、position 默认值", () => {
    const workflow = makeWorkflow([makeNode("a", "start"), makeNode("b", "end")], [makeStartEndEdge()]);
    const graph = toEditorGraph(workflow);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({ id: "a", type: "start", name: "a" });
    expect(graph.nodes[1]).toMatchObject({ id: "b", type: "end", name: "b" });
    expect(graph.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(graph.nodes[1]?.position).toEqual({ x: 0, y: 0 });
    expect(graph.edges).toEqual(workflow.edges);
    expect(graph.entryNodeId).toBe("a");
    expect(graph.id).toBe("wf");
    expect(graph.name).toBe("wf");
    expect(graph.version).toBe("0.1.0");
  });

  test("显式 position 原样保留，不补默认值", () => {
    const workflow = makeWorkflow(
      [makeNode("a", "start", { position: { x: 12, y: 34 } })],
      [],
    );
    const graph = toEditorGraph(workflow);
    expect(graph.nodes[0]?.position).toEqual({ x: 12, y: 34 });
  });

  test("无 start 节点时不标 entryNodeId", () => {
    const workflow = makeWorkflow([makeNode("a", "end")], []);
    const graph = toEditorGraph(workflow);
    expect("entryNodeId" in graph).toBe(false);
  });
});

describe("toEditorGraph 嵌套子工作流", () => {
  test("递归转换：subworkflow 层级、内层 entryNodeId 与图元信息", () => {
    const inner = makeWorkflow(
      [makeNode("ia", "start"), makeNode("ib", "end")],
      [
        {
          id: "ie1",
          sourceNodeId: "ia",
          sourcePortId: "data",
          targetNodeId: "ib",
          targetPortId: "in",
        },
      ],
      "wf-inner",
      "wf-inner",
      "0.1.0",
    );
    const workflow = makeWorkflow(
      [
        makeNode("oa", "start"),
        makeNode("ob", "subworkflow", { subworkflow: inner, position: { x: 5, y: 6 } }),
        makeNode("oc", "end"),
      ],
      [
        {
          id: "oe1",
          sourceNodeId: "oa",
          sourcePortId: "data",
          targetNodeId: "oc",
          targetPortId: "in",
        },
      ],
      "wf-outer",
      "wf-outer",
      "0.2.0",
    );
    const graph = toEditorGraph(workflow);
    const sub = graph.nodes[1]?.subworkflow;
    expect(sub).toBeDefined();
    expect(sub?.nodes.map((node) => node.id)).toEqual(["ia", "ib"]);
    expect(sub?.entryNodeId).toBe("ia");
    expect(sub?.id).toBe("wf-inner");
    expect(sub?.name).toBe("wf-inner");
    expect(sub?.version).toBe("0.1.0");
    expect(graph.nodes[1]?.position).toEqual({ x: 5, y: 6 });
  });
});

describe("fromEditorGraph 往返一致性", () => {
  test("简单工作流 deepEqual（含 position、params、端口）", () => {
    const workflow = makeWorkflow(
      [
        makeNode("a", "start", { position: { x: 1, y: 2 }, params: { mode: "prod" } }),
        makeNode("b", "end", { position: { x: 3, y: 4 } }),
      ],
      [makeStartEndEdge()],
    );
    const restored = fromEditorGraph(toEditorGraph(workflow), {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
    });
    expect(restored).toEqual(workflow);
  });

  test("嵌套子工作流 deepEqual（递归往返，含子图元信息）", () => {
    const inner = makeWorkflow(
      [
        makeNode("ia", "start", { position: { x: 9, y: 9 } }),
        makeNode("ib", "end", { position: { x: 10, y: 10 } }),
      ],
      [
        {
          id: "ie1",
          sourceNodeId: "ia",
          sourcePortId: "data",
          targetNodeId: "ib",
          targetPortId: "in",
        },
      ],
      "wf-inner",
      "wf-inner",
      "0.1.0",
    );
    const workflow = makeWorkflow(
      [
        makeNode("oa", "start", { position: { x: 1, y: 2 } }),
        makeNode("ob", "subworkflow", { subworkflow: inner, position: { x: 3, y: 4 } }),
        makeNode("oc", "end", { position: { x: 5, y: 6 } }),
      ],
      [
        {
          id: "oe1",
          sourceNodeId: "oa",
          sourcePortId: "data",
          targetNodeId: "oc",
          targetPortId: "in",
        },
      ],
      "wf-outer",
      "wf-outer",
      "0.2.0",
    );
    const restored = fromEditorGraph(toEditorGraph(workflow), {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
    });
    expect(restored).toEqual(workflow);
  });

  test("缺失 position 往返后补为默认坐标并保留", () => {
    const workflow = makeWorkflow([makeNode("a", "start")], []);
    const restored = fromEditorGraph(toEditorGraph(workflow), {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
    });
    // 定案：缺失 position 补默认坐标，fromEditorGraph 原样保留（不还原为 undefined）。
    expect(restored.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(restored.nodes[0]?.id).toBe("a");
    expect(restored.nodes[0]?.type).toBe("start");
    expect(restored.id).toBe("wf");
  });
});

describe("fromEditorGraph 结构防御", () => {
  test("节点 id 为空串抛错", () => {
    const bad: EditorGraph = {
      id: "wf",
      name: "wf",
      version: "0.1.0",
      nodes: [
        { id: "  ", type: "start", name: "a", params: {}, inputs: [], outputs: [], position: { x: 0, y: 0 } },
      ],
      edges: [],
    };
    expect(() => fromEditorGraph(bad, { id: "wf", name: "wf", version: "0.1.0" })).toThrow(
      /id 为空/,
    );
  });

  test("节点 id 重复抛错", () => {
    const bad: EditorGraph = {
      id: "wf",
      name: "wf",
      version: "0.1.0",
      nodes: [
        { id: "dup", type: "start", name: "a", params: {}, inputs: [], outputs: [], position: { x: 0, y: 0 } },
        { id: "dup", type: "end", name: "b", params: {}, inputs: [], outputs: [], position: { x: 0, y: 0 } },
      ],
      edges: [],
    };
    expect(() => fromEditorGraph(bad, { id: "wf", name: "wf", version: "0.1.0" })).toThrow(
      /id 重复/,
    );
  });
});

describe("toEditorGraph 非法工作流抛错", () => {
  test("边引用不存在的节点 → 抛错，消息含 errors", () => {
    const bad = makeWorkflow([makeNode("a", "start")], [
      {
        id: "e1",
        sourceNodeId: "a",
        sourcePortId: "data",
        targetNodeId: "ghost",
        targetPortId: "in",
      },
    ]);
    expect(() => toEditorGraph(bad)).toThrow(/ghost/);
  });

  test("端口类型不匹配 → 抛错", () => {
    const bad = makeWorkflow(
      [
        makeNode("a", "start", {
          outputs: [makePort("out", "out", "number", "out")],
        }),
        makeNode("b", "end", {
          inputs: [makePort("in", "in", "string", "in")],
        }),
      ],
      [
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePortId: "out",
          targetNodeId: "b",
          targetPortId: "in",
        },
      ],
    );
    expect(() => toEditorGraph(bad)).toThrow(/type mismatch/);
  });
});
