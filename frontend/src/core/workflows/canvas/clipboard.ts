import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  makeEdgeId,
  type RFEdge,
  type RFNode,
} from "./mapping";
import { makeNodeId } from "./node-catalog";
import type { WorkflowNode } from "./types";

/**
 * Canvas clipboard payload. Positions are stored relative to the copied
 * selection's top-left corner so paste can place the group under the cursor.
 */
export type ClipboardNode = {
  offset: { x: number; y: number };
  workflow: WorkflowNode;
  displayName?: string;
  width?: number;
  height?: number;
};

export type ClipboardEdge = {
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  condition: string | null;
};

export type WorkflowClipboard = {
  nodes: ClipboardNode[];
  edges: ClipboardEdge[];
};

/**
 * Snapshot the selected nodes and the edges wholly inside the selection.
 * Returns `null` when no node carries a workflow payload.
 */
export function copySelection(
  nodes: RFNode[],
  edges: RFEdge[],
  selectedIds: Iterable<string>,
): WorkflowClipboard | null {
  const selected = new Set(selectedIds);
  const copied = nodes.filter(
    (node) => selected.has(node.id) && node.data?.workflow,
  );
  if (copied.length === 0) {
    return null;
  }

  const minX = Math.min(...copied.map((node) => node.position.x));
  const minY = Math.min(...copied.map((node) => node.position.y));
  const copiedIds = new Set(copied.map((node) => node.id));

  return {
    nodes: copied.map((node) => ({
      offset: {
        x: node.position.x - minX,
        y: node.position.y - minY,
      },
      workflow: structuredClone(node.data.workflow),
      ...(node.data.displayName ? { displayName: node.data.displayName } : {}),
      ...(typeof node.width === "number" ? { width: node.width } : {}),
      ...(typeof node.height === "number" ? { height: node.height } : {}),
    })),
    edges: edges
      .filter(
        (edge) => copiedIds.has(edge.source) && copiedIds.has(edge.target),
      )
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        condition: edge.data?.condition ?? null,
      })),
  };
}

/**
 * Materialize a clipboard payload at a flow-space position. Fresh node ids and
 * edge ids are generated; `existingIds` prevents collisions with the canvas.
 */
export function pasteClipboard(
  clipboard: WorkflowClipboard,
  position: { x: number; y: number },
  existingIds: Iterable<string> = [],
): { nodes: RFNode[]; edges: RFEdge[] } {
  const usedIds = new Set(existingIds);
  const idMap = new Map<string, string>();

  const nodes: RFNode[] = clipboard.nodes.map((item) => {
    let id = makeNodeId();
    while (usedIds.has(id)) {
      id = makeNodeId();
    }
    usedIds.add(id);
    idMap.set(item.workflow.id, id);

    const workflow = structuredClone(item.workflow);
    workflow.id = id;
    return {
      id,
      type: workflow.type,
      position: {
        x: position.x + item.offset.x,
        y: position.y + item.offset.y,
      },
      data: {
        workflow,
        ...(item.displayName ? { displayName: item.displayName } : {}),
      },
      width: item.width ?? DEFAULT_NODE_WIDTH,
      height: item.height ?? DEFAULT_NODE_HEIGHT,
      selected: true,
    };
  });

  const edges: RFEdge[] = clipboard.edges.flatMap((edge) => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source || !target) {
      return [];
    }
    const sourcePort = edge.sourceHandle ?? "";
    const targetPort = edge.targetHandle ?? "";
    return [
      {
        id: makeEdgeId(source, sourcePort, target, targetPort),
        source,
        sourceHandle: edge.sourceHandle,
        target,
        targetHandle: edge.targetHandle,
        ...(edge.condition != null
          ? { data: { condition: edge.condition } }
          : {}),
      },
    ];
  });

  return { nodes, edges };
}
