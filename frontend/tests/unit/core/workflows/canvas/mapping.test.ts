import { describe, expect, test } from "@rstest/core";

import {
  definitionToFlow,
  edgeIdOf,
  flowToDefinition,
  makeEdgeId,
  makeNodeId,
  type RFEdge,
  type RFNode,
} from "@/core/workflows/canvas/mapping";
import type { NodeType, WorkflowDefinition } from "@/core/workflows/types";

/** Narrow the canvas block out of the untyped metadata index signature. */
const positionsOf = (def: WorkflowDefinition) =>
  (
    def.metadata.canvas as
      | { positions?: Record<string, { x: number; y: number }> }
      | undefined
  )?.positions;

const sampleDefinition = (): WorkflowDefinition => ({
  id: "wf-1",
  name: "Sample",
  version: "0.1.0",
  metadata: {
    created_at: "2026-01-01T00:00:00Z",
    canvas: {
      positions: {
        "n-start": { x: 0, y: 0 },
        "n-llm": { x: 280, y: 0 },
        "n-end": { x: 560, y: 0 },
      },
    },
  },
  nodes: [
    {
      id: "n-start",
      type: "flow:start",
      inputs: [],
      outputs: [{ name: "out", type: "data", required: true }],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
    {
      id: "n-llm",
      type: "ai:llm_agent",
      inputs: [{ name: "in", type: "data", required: true }],
      outputs: [{ name: "out", type: "data", required: true }],
      params: { instruction: "Summarize" },
      capability_groups: ["research"],
      agent_name: "lead",
    },
    {
      id: "n-end",
      type: "flow:end",
      inputs: [{ name: "in", type: "data", required: true }],
      outputs: [],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
  ],
  edges: [
    {
      source: "n-start",
      source_port: "out",
      target: "n-llm",
      target_port: "in",
    },
    {
      source: "n-llm",
      source_port: "out",
      target: "n-end",
      target_port: "in",
      condition: "ok",
    },
  ],
});

describe("definitionToFlow", () => {
  test("maps nodes with clean workflow data and preserved order", () => {
    const def = sampleDefinition();
    const { nodes } = definitionToFlow(def);

    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.id)).toEqual(["n-start", "n-llm", "n-end"]);
    expect(nodes.map((n) => n.type)).toEqual([
      "flow:start",
      "ai:llm_agent",
      "flow:end",
    ]);

    const llm = nodes[1]!;
    expect(llm.data.workflow).toEqual(def.nodes[1]!);
    expect(llm.data.workflow).not.toBe(def.nodes[1]!);
  });

  test("reads positions from metadata.canvas.positions", () => {
    const { nodes, positions } = definitionToFlow(sampleDefinition());
    expect(positions).toEqual({
      "n-start": { x: 0, y: 0 },
      "n-llm": { x: 280, y: 0 },
      "n-end": { x: 560, y: 0 },
    });
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 280, y: 0 },
      { x: 560, y: 0 },
    ]);
  });

  test("falls back to a non-overlapping grid layout without positions", () => {
    const def = sampleDefinition();
    delete def.metadata.canvas;
    const { nodes } = definitionToFlow(def);

    const seen = new Set<string>();
    for (const [i, node] of nodes.entries()) {
      const { x, y } = node.position;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      const key = `${x},${y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      // Grid invariant: x on the 280 column, y on the 120 row.
      expect(x % 280).toBe(0);
      expect(y % 120).toBe(0);
      expect(node.id).toBe(def.nodes[i]!.id);
    }
    expect(nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(nodes[1]!.position).toEqual({ x: 280, y: 0 });
    expect(nodes[2]!.position).toEqual({ x: 560, y: 0 });
  });

  test("wraps to the next grid row every 3 nodes", () => {
    const def = sampleDefinition();
    delete def.metadata.canvas;
    def.nodes.push({
      id: "n-extra",
      type: "tool:log",
      inputs: [{ name: "in", type: "data", required: true }],
      outputs: [{ name: "out", type: "data", required: true }],
      params: { message: "hi" },
      capability_groups: [],
      agent_name: null,
    });
    const { nodes } = definitionToFlow(def);
    expect(nodes[3]!.position).toEqual({ x: 0, y: 120 });
  });

  test("edge ids are deterministic and port-qualified", () => {
    const def = sampleDefinition();
    const first = definitionToFlow(def);
    const second = definitionToFlow(def);

    expect(first.edges).toHaveLength(2);
    expect(first.edges[0]!.id).toBe("n-start::out::n-llm::in");
    expect(first.edges[1]!.id).toBe("n-llm::out::n-end::in");
    expect(first.edges.map((e) => e.id)).toEqual(second.edges.map((e) => e.id));
  });

  test("maps edge sourceHandle/targetHandle and preserves condition", () => {
    const { edges } = definitionToFlow(sampleDefinition());
    expect(edges[0]!.sourceHandle).toBe("out");
    expect(edges[0]!.targetHandle).toBe("in");
    expect(edges[1]!.data?.condition).toBe("ok");
    expect(edges[0]!.data?.condition).toBeUndefined();
  });

  test("tolerates unknown node types without dropping data", () => {
    const def = sampleDefinition();
    const unknownType = "legacy:custom" as NodeType;
    def.nodes.push({
      id: "n-unknown",
      type: unknownType,
      inputs: [],
      outputs: [{ name: "out", type: "enum", required: false }],
      params: { keep: "me" },
      capability_groups: [],
      agent_name: null,
    });

    const { nodes } = definitionToFlow(def);
    expect(nodes).toHaveLength(4);
    expect(nodes[3]!.data.workflow.type).toBe(unknownType);
    expect(nodes[3]!.data.workflow.params).toEqual({ keep: "me" });
  });
});

describe("flowToDefinition", () => {
  test("round-trips nodes, ports, params, edges, conditions and order", () => {
    const def = sampleDefinition();
    const flow = definitionToFlow(def);
    const { definition } = flowToDefinition(flow, { def, positions: {} });

    expect(definition.id).toBe("wf-1");
    expect(definition.name).toBe("Sample");
    expect(definition.version).toBe("0.1.0");

    expect(definition.nodes).toHaveLength(def.nodes.length);
    definition.nodes.forEach((node, i) => {
      expect(node.id).toBe(def.nodes[i]!.id);
      expect(node.type).toBe(def.nodes[i]!.type);
      expect(node.inputs).toEqual(def.nodes[i]!.inputs);
      expect(node.outputs).toEqual(def.nodes[i]!.outputs);
      expect(node.params).toEqual(def.nodes[i]!.params);
      expect(node.capability_groups).toEqual(def.nodes[i]!.capability_groups);
      expect(node.agent_name).toEqual(def.nodes[i]!.agent_name);
    });

    expect(definition.edges).toHaveLength(def.edges.length);
    definition.edges.forEach((edge, i) => {
      expect(edge.source).toBe(def.edges[i]!.source);
      expect(edge.source_port).toBe(def.edges[i]!.source_port);
      expect(edge.target).toBe(def.edges[i]!.target);
      expect(edge.target_port).toBe(def.edges[i]!.target_port);
      expect(edge.condition).toBe(def.edges[i]!.condition);
    });
  });

  test("does not write edge ids back into the definition", () => {
    const def = sampleDefinition();
    const flow = definitionToFlow(def);
    const { definition } = flowToDefinition(flow, { def, positions: {} });
    for (const edge of definition.edges) {
      expect(edge).not.toHaveProperty("id");
    }
  });

  test("round-trips positions into metadata.canvas.positions and keeps other keys", () => {
    const def = sampleDefinition();
    const flow = definitionToFlow(def);
    const { definition, metadata } = flowToDefinition(flow, {
      def,
      positions: {},
    });

    expect(metadata.canvas?.positions).toEqual(positionsOf(def));
    expect(definition.metadata).toBe(metadata);
    expect(definition.metadata.created_at).toBe("2026-01-01T00:00:00Z");
  });

  test("reads custom display names and drops labels that equal the default name", () => {
    const def = sampleDefinition();
    def.metadata.canvas = {
      positions: positionsOf(def),
      labels: {
        "n-start": "  Start  ",
        "n-llm": "  Brain  ",
      },
    };

    const flow = definitionToFlow(def);

    expect(flow.nodes[0]!.data.displayName).toBeUndefined();
    expect(flow.nodes[1]!.data.displayName).toBe("Brain");
    expect(flow.nodes[2]!.data.displayName).toBeUndefined();
  });

  test("round-trips custom display names into metadata.canvas.labels", () => {
    const def = sampleDefinition();
    const flow = definitionToFlow(def);
    flow.nodes[1]!.data.displayName = "Thinker";
    flow.nodes[2]!.data.displayName = "Wrap up";

    const { definition, metadata } = flowToDefinition(flow, {
      def,
      positions: {},
    });

    expect(metadata.canvas?.labels).toEqual({
      "n-llm": "Thinker",
      "n-end": "Wrap up",
    });
    expect(definition.metadata).toBe(metadata);
  });

  test("removing a custom display name clears its stored label", () => {
    const def = sampleDefinition();
    def.metadata.canvas = {
      positions: positionsOf(def),
      labels: { "n-llm": "Thinker" },
    };
    const flow = definitionToFlow(def);
    delete flow.nodes[1]!.data.displayName;

    const { metadata } = flowToDefinition(flow, { def, positions: {} });

    expect(metadata.canvas?.labels).toEqual({});
  });

  test("uses RF node positions and preserves base positions for off-canvas nodes", () => {
    const def = sampleDefinition();
    const flow = definitionToFlow(def);
    flow.nodes[0]!.position = { x: 999, y: 42 };
    const basePositions = { "n-offscreen": { x: 1, y: 2 } };

    const { metadata } = flowToDefinition(flow, {
      def,
      positions: basePositions,
    });

    expect(metadata.canvas?.positions?.["n-start"]).toEqual({ x: 999, y: 42 });
    expect(metadata.canvas?.positions?.["n-offscreen"]).toEqual({ x: 1, y: 2 });
    expect(metadata.canvas?.positions?.["n-llm"]).toEqual({ x: 280, y: 0 });
  });

  test("rebuilds a node from the catalog when data.workflow is missing", () => {
    const def = sampleDefinition();
    const flow = definitionToFlow(def);
    const orphan: RFNode = {
      id: "n-new",
      type: "tool:log",
      position: { x: 0, y: 0 },
      data: { workflow: undefined as never },
    };
    flow.nodes.push(orphan);

    const { definition } = flowToDefinition(flow, { def, positions: {} });
    const rebuilt = definition.nodes.find((n) => n.id === "n-new");
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.type).toBe("tool:log");
    expect(rebuilt?.params).toEqual({ message: "" });
  });

  test("preserves unknown types with data.workflow through the round trip", () => {
    const def = sampleDefinition();
    const unknownType = "legacy:custom" as NodeType;
    def.nodes.push({
      id: "n-unknown",
      type: unknownType,
      inputs: [],
      outputs: [{ name: "out", type: "enum" }],
      params: { keep: "me" },
      capability_groups: [],
      agent_name: null,
    });

    const flow = definitionToFlow(def);
    const { definition } = flowToDefinition(flow, { def, positions: {} });
    expect(definition.nodes).toHaveLength(4);
    expect(definition.nodes[3]!.type).toBe(unknownType);
    expect(definition.nodes[3]!.params).toEqual({ keep: "me" });
  });
});

describe("edge helpers", () => {
  test("makeEdgeId joins the four components with ::", () => {
    expect(makeEdgeId("n-a", "out", "n-b", "in")).toBe("n-a::out::n-b::in");
  });

  test("edgeIdOf derives the deterministic id from an RF edge", () => {
    const edge: RFEdge = {
      id: "anything",
      source: "n-a",
      sourceHandle: "out",
      target: "n-b",
      targetHandle: "in",
    };
    expect(edgeIdOf(edge)).toBe("n-a::out::n-b::in");
  });

  test("makeNodeId produces n_ + 8 hex chars", () => {
    expect(makeNodeId()).toMatch(/^n_[0-9a-f]{8}$/);
    expect(makeNodeId()).not.toBe(makeNodeId());
  });

  test("edgeIdOf matches the id assigned by definitionToFlow", () => {
    const { edges } = definitionToFlow(sampleDefinition());
    for (const edge of edges) {
      expect(edge.id).toBe(edgeIdOf(edge));
    }
  });
});
