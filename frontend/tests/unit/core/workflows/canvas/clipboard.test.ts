import { describe, expect, it } from "@rstest/core";

import {
  copySelection,
  pasteClipboard,
  type WorkflowClipboard,
} from "@/core/workflows/canvas/clipboard";
import type { RFEdge, RFNode } from "@/core/workflows/canvas/mapping";
import type { WorkflowNode } from "@/core/workflows/canvas/types";

function workflowNode(
  id: string,
  type: WorkflowNode["type"] = "data:assign",
): WorkflowNode {
  return {
    id,
    type,
    inputs: [{ name: "in", type: "data", required: true }],
    outputs: [{ name: "out", type: "data", required: true }],
    params: { value: id },
    capability_groups: [],
    agent_name: null,
  };
}

function rfNode(
  id: string,
  x: number,
  y: number,
  selected = false,
  displayName?: string,
): RFNode {
  return {
    id,
    type: "data:assign",
    position: { x, y },
    data: {
      workflow: workflowNode(id),
      ...(displayName ? { displayName } : {}),
    },
    selected,
  };
}

function rfEdge(
  source: string,
  target: string,
  condition: string | null = null,
): RFEdge {
  return {
    id: `${source}::out::${target}::in`,
    source,
    sourceHandle: "out",
    target,
    targetHandle: "in",
    ...(condition != null ? { data: { condition } } : {}),
  };
}

describe("workflow canvas clipboard", () => {
  it("returns null when the selection has no workflow nodes", () => {
    expect(copySelection([rfNode("a", 0, 0)], [], [])).toBeNull();
    expect(copySelection([rfNode("a", 0, 0)], [], ["missing"])).toBeNull();
  });

  it("copies selected nodes relative to the selection top-left", () => {
    const nodes = [
      rfNode("a", 100, 200, true),
      rfNode("b", 340, 260, true),
      rfNode("c", 800, 900),
    ];
    const edges = [
      rfEdge("a", "b", "when_true"),
      rfEdge("a", "c"),
      rfEdge("b", "c"),
    ];

    const clipboard = copySelection(nodes, edges, ["a", "b"])!;

    expect(clipboard.nodes).toHaveLength(2);
    expect(clipboard.nodes.map((node) => node.workflow.id)).toEqual(["a", "b"]);
    expect(clipboard.nodes.map((node) => node.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 240, y: 60 },
    ]);
    expect(clipboard.edges).toEqual([
      {
        source: "a",
        target: "b",
        sourceHandle: "out",
        targetHandle: "in",
        condition: "when_true",
      },
    ]);
    // The copied payload is detached from the canvas objects.
    expect(clipboard.nodes[0]!.workflow).not.toBe(nodes[0]!.data.workflow);
  });

  it("pastes with fresh ids, remapped edges, and a configurable anchor", () => {
    const clipboard: WorkflowClipboard = {
      nodes: [
        {
          offset: { x: 0, y: 0 },
          workflow: workflowNode("a"),
        },
        {
          offset: { x: 100, y: 50 },
          workflow: workflowNode("b"),
        },
      ],
      edges: [
        {
          source: "a",
          target: "b",
          sourceHandle: "out",
          targetHandle: "in",
          condition: "always",
        },
      ],
    };

    const pasted = pasteClipboard(clipboard, { x: 600, y: 700 }, ["existing"]);

    expect(pasted.nodes).toHaveLength(2);
    expect(pasted.nodes[0]!.id).not.toBe("a");
    expect(pasted.nodes[1]!.id).not.toBe("b");
    expect(pasted.nodes[0]!.position).toEqual({ x: 600, y: 700 });
    expect(pasted.nodes[1]!.position).toEqual({ x: 700, y: 750 });
    expect(pasted.nodes.every((node) => node.selected)).toBe(true);
    expect(pasted.nodes[0]!.data.workflow.id).toBe(pasted.nodes[0]!.id);
    expect(pasted.edges).toHaveLength(1);
    expect(pasted.edges[0]!.source).toBe(pasted.nodes[0]!.id);
    expect(pasted.edges[0]!.target).toBe(pasted.nodes[1]!.id);
    expect(pasted.edges[0]!.id).toBe(
      `${pasted.nodes[0]!.id}::out::${pasted.nodes[1]!.id}::in`,
    );
    expect(pasted.edges[0]!.data?.condition).toBe("always");
  });

  it("carries custom display names through copy and paste", () => {
    const nodes = [rfNode("a", 0, 0, true, "Entry point")];

    const clipboard = copySelection(nodes, [], ["a"])!;
    expect(clipboard.nodes[0]!.displayName).toBe("Entry point");

    const pasted = pasteClipboard(clipboard, { x: 10, y: 20 });
    expect(pasted.nodes[0]!.data.displayName).toBe("Entry point");
    expect(pasted.nodes[0]!.data.workflow).not.toHaveProperty("displayName");
  });
});
