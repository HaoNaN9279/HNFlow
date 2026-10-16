/**
 * Tests for `@/core/workflows/canvas/templates` — the pure canvas template
 * insertion transform (N14 §24.6b).
 */

import { describe, expect, it } from "@rstest/core";

import type { RFNode } from "@/core/workflows/canvas/mapping";
import {
  TEMPLATE_GAP_X,
  insertTemplateFlow,
  templateAnchor,
  uniqueNodeId,
} from "@/core/workflows/canvas/templates";
import type {
  WorkflowDefinition,
  WorkflowNode,
} from "@/core/workflows/canvas/types";

function workflowNode(id: string, type = "flow:start"): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    inputs: [],
    outputs: [{ name: "out", type: "data" }],
    params: {},
  };
}

function template(): WorkflowDefinition {
  return {
    id: "wf-template",
    name: "Template",
    version: "0.1.0",
    nodes: [
      workflowNode("start"),
      workflowNode("producer", "ai:llm_agent"),
      workflowNode("end", "flow:end"),
    ],
    edges: [
      {
        source: "start",
        source_port: "out",
        target: "producer",
        target_port: "in",
      },
      {
        source: "producer",
        source_port: "out",
        target: "end",
        target_port: "in",
      },
    ],
    metadata: {
      canvas: {
        positions: {
          start: { x: 0, y: 0 },
          producer: { x: 280, y: 0 },
          end: { x: 560, y: 0 },
        },
      },
    },
  };
}

function rfNode(id: string, x: number, y: number): RFNode {
  return {
    id,
    type: "flow:start",
    position: { x, y },
    data: { workflow: workflowNode(id) },
  };
}

describe("uniqueNodeId", () => {
  it("keeps the original id when it is free", () => {
    expect(uniqueNodeId("start", new Set())).toBe("start");
  });

  it("suffixes past every taken variant", () => {
    const taken = new Set(["start", "start-2", "start-3"]);
    expect(uniqueNodeId("start", taken)).toBe("start-4");
  });

  it("only collision-suffixes, never renumbers a free id", () => {
    expect(uniqueNodeId("n1", new Set(["other"]))).toBe("n1");
  });
});

describe("templateAnchor", () => {
  it("places an empty canvas at the origin", () => {
    expect(templateAnchor([])).toEqual({ x: 0, y: 0 });
  });

  it("places the template to the right of the existing content", () => {
    const nodes = [rfNode("a", 10, 40), rfNode("b", 300, 5)];
    expect(templateAnchor(nodes)).toEqual({ x: 300 + TEMPLATE_GAP_X, y: 5 });
  });

  it("honours an explicit position", () => {
    expect(templateAnchor([rfNode("a", 10, 40)], { x: 1, y: 2 })).toEqual({
      x: 1,
      y: 2,
    });
  });
});

describe("insertTemplateFlow", () => {
  it("inserts a template verbatim on an empty canvas", () => {
    const insertion = insertTemplateFlow(template(), { existingNodes: [] });
    expect(insertion.nodes.map((node) => node.id)).toEqual([
      "start",
      "producer",
      "end",
    ]);
    expect(insertion.nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(insertion.positions).toEqual({
      start: { x: 0, y: 0 },
      producer: { x: 280, y: 0 },
      end: { x: 560, y: 0 },
    });
  });

  it("remaps colliding ids and keeps the definition payload in sync", () => {
    const existing = [rfNode("start", 0, 0)];
    const insertion = insertTemplateFlow(template(), {
      existingNodes: existing,
    });
    expect(insertion.nodes.map((node) => node.id)).toEqual([
      "start-2",
      "producer",
      "end",
    ]);
    // The stashed definition node must carry the new id, not the template's.
    expect(insertion.nodes[0]!.data?.workflow.id).toBe("start-2");
    expect(insertion.nodes[1]!.data?.workflow.id).toBe("producer");
  });

  it("remaps edges onto the rewritten ids", () => {
    const insertion = insertTemplateFlow(template(), {
      existingNodes: [rfNode("start", 0, 0)],
    });
    expect(insertion.edges.map((edge) => edge.id)).toEqual([
      "start-2::out::producer::in",
      "producer::out::end::in",
    ]);
    expect(insertion.edges[0]!.source).toBe("start-2");
    expect(insertion.edges[0]!.target).toBe("producer");
  });

  it("preserves edge conditions through the insert", () => {
    const definition = template();
    const [firstEdge, ...restEdges] = definition.edges;
    definition.edges = [
      { ...firstEdge!, condition: "needs_revision" },
      ...restEdges,
    ];
    const insertion = insertTemplateFlow(definition, { existingNodes: [] });
    expect(insertion.edges[0]!.data).toEqual({ condition: "needs_revision" });
  });

  it("offsets the inserted layout beside the existing content", () => {
    const insertion = insertTemplateFlow(template(), {
      existingNodes: [rfNode("existing", 100, 50)],
    });
    const anchorX = 100 + TEMPLATE_GAP_X;
    expect(insertion.positions.producer).toEqual({ x: anchorX + 280, y: 50 });
  });

  it("uses an explicit position when given one", () => {
    const insertion = insertTemplateFlow(template(), {
      existingNodes: [rfNode("existing", 100, 50)],
      position: { x: 7, y: 9 },
    });
    expect(insertion.positions.start).toEqual({ x: 7, y: 9 });
    expect(insertion.positions.end).toEqual({ x: 567, y: 9 });
  });

  it("falls back to the grid layout when the template has no stored positions", () => {
    const definition = template();
    definition.metadata = {};
    const insertion = insertTemplateFlow(definition, { existingNodes: [] });
    expect(insertion.nodes).toHaveLength(3);
    expect(insertion.positions.start).toEqual({ x: 0, y: 0 });
    expect(insertion.positions.producer).toEqual({ x: 280, y: 0 });
  });

  it("does not mutate the template definition or the existing nodes", () => {
    const definition = template();
    const before = JSON.stringify(definition);
    const existing = [rfNode("start", 0, 0)];
    const existingBefore = JSON.stringify(existing);
    insertTemplateFlow(definition, { existingNodes: existing });
    expect(JSON.stringify(definition)).toBe(before);
    expect(JSON.stringify(existing)).toBe(existingBefore);
  });

  it("is deterministic across repeated calls", () => {
    const first = insertTemplateFlow(template(), { existingNodes: [] });
    const second = insertTemplateFlow(template(), { existingNodes: [] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
