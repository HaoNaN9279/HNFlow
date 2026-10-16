/**
 * Canvas template insertion (N14 §24.6b).
 *
 * A template is a complete `WorkflowDefinition` skeleton shipped by the backend
 * (`workflow/patterns.py`). Inserting one must not disturb the document already
 * on the canvas, so this module is a **pure** transform: it rewrites every
 * template node id to a canvas-unique id, remaps the template edges onto those
 * ids, and offsets the template's layout so the insert lands beside the
 * existing content instead of on top of it.
 *
 * Deterministic on purpose (no randomness, no timestamps): the same canvas +
 * template always produces the same ids and positions, which keeps ids stable
 * across a save/reload round trip.
 */

import {
  definitionToFlow,
  makeEdgeId,
  type PositionsMap,
  type RFEdge,
  type RFNode,
} from "./mapping";
import type { WorkflowDefinition } from "./types";

/** Horizontal gap between the existing content and an inserted template. */
export const TEMPLATE_GAP_X = 320;

export type TemplateInsertion = {
  /** The template's nodes, remapped and repositioned. */
  nodes: RFNode[];
  /** The template's edges, remapped onto the new node ids. */
  edges: RFEdge[];
  /** Effective positions of the inserted nodes (for `metadata.canvas.positions`). */
  positions: PositionsMap;
};

function takenNodeIds(nodes: RFNode[]): Set<string> {
  return new Set(nodes.map((node) => node.id));
}

/**
 * First free id for *baseId* given the ids already on the canvas.
 *
 * Keeps the readable original id when it is unused (a fresh canvas inserts the
 * template verbatim) and only suffixes on collision (`start` → `start-2`).
 */
export function uniqueNodeId(
  baseId: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  let candidate = `${baseId}-${suffix}`;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${baseId}-${suffix}`;
  }
  return candidate;
}

/**
 * Where an inserted template's top-left corner goes.
 *
 * Explicit `position` wins; otherwise the template is placed to the right of
 * everything already on the canvas (top-aligned with the topmost node), and an
 * empty canvas places it at the origin.
 */
export function templateAnchor(
  nodes: RFNode[],
  position?: { x: number; y: number },
): { x: number; y: number } {
  if (position) {
    return { ...position };
  }
  if (nodes.length === 0) {
    return { x: 0, y: 0 };
  }
  const maxX = Math.max(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  return { x: maxX + TEMPLATE_GAP_X, y: minY };
}

/**
 * Build the nodes/edges/positions for inserting *template* onto a canvas.
 *
 * The caller appends the result to its existing `nodes`/`edges`
 * (`setNodes((current) => [...current, ...insertion.nodes])`), so this never
 * needs to know how the canvas stores its state.
 */
export function insertTemplateFlow(
  template: WorkflowDefinition,
  options: {
    existingNodes: RFNode[];
    position?: { x: number; y: number };
  },
): TemplateInsertion {
  const taken = takenNodeIds(options.existingNodes);
  const anchor = templateAnchor(options.existingNodes, options.position);
  const templateFlow = definitionToFlow(template);

  // Two passes: assign every id first, then remap edges, so an edge can never
  // resolve against a partly-renamed set.
  const idMap = new Map<string, string>();
  for (const node of templateFlow.nodes) {
    const nextId = uniqueNodeId(node.id, taken);
    taken.add(nextId);
    idMap.set(node.id, nextId);
  }

  const positions: PositionsMap = {};
  const nodes: RFNode[] = templateFlow.nodes.map((node) => {
    const relative = templateFlow.positions[node.id] ?? { x: 0, y: 0 };
    const position = { x: anchor.x + relative.x, y: anchor.y + relative.y };
    positions[idMap.get(node.id)!] = position;
    return {
      ...node,
      id: idMap.get(node.id)!,
      position,
      data: node.data?.workflow
        ? { workflow: { ...node.data.workflow, id: idMap.get(node.id)! } }
        : node.data,
    };
  });

  const edges: RFEdge[] = templateFlow.edges.map((edge) => {
    const source = idMap.get(edge.source)!;
    const target = idMap.get(edge.target)!;
    const sourceHandle = edge.sourceHandle ?? "";
    const targetHandle = edge.targetHandle ?? "";
    return {
      ...edge,
      id: makeEdgeId(source, sourceHandle, target, targetHandle),
      source,
      target,
    };
  });

  return { nodes, edges, positions };
}
