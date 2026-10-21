/**
 * Canvas mapping layer —converts between the serialisable workflow definition
 * (`WorkflowDefinition`) and React Flow's runtime node/edge objects.
 *
 * - `definitionToFlow` is the definition 鈫?RF direction: positions come from
 *   `metadata.canvas.positions` (grid fallback when absent), the raw definition
 *   node is stashed clean inside `data.workflow`, and edge ids are deterministic
 *   `${source}::${source_port}::${target}::${target_port}` strings.
 * - `flowToDefinition` is the RF 鈫?definition direction: nodes are copied back
 *   from `data.workflow` (or rebuilt from the node catalog for fresh canvas
 *   nodes), edges drop their RF id, and node positions are collected back into
 *   `metadata.canvas.positions`.
 */

import type { Edge as RFEdgeBase, Node as RFNodeBase } from "@xyflow/react";

import { getDefaultNode, normalizeNodeDisplayName } from "./node-catalog";
import { sanitizeNodeParams } from "./node-property-schema";
import type {
  CanvasLabels,
  CanvasPositions,
  CanvasSizes,
  NodeType,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowMetadata,
  WorkflowNode,
} from "./types";

export { makeNodeId } from "./node-catalog";

/** RF node data: wraps the clean definition node (with ports/params) and the
 *  canvas-only custom label. `displayName` never enters the definition node. */
export type WorkflowNodeData = {
  workflow: WorkflowNode;
  displayName?: string;
};
/** RF edge data: carries the definition condition so it survives the round trip. */
export type WorkflowEdgeData = { condition?: string | null };

export type RFNode = RFNodeBase<WorkflowNodeData>;
export type RFEdge = RFEdgeBase<WorkflowEdgeData>;

export type PositionsMap = Record<string, { x: number; y: number }>;

export type FlowResult = {
  nodes: RFNode[];
  edges: RFEdge[];
  positions: PositionsMap;
};

const GRID_COLUMNS = 3;
const GRID_X = 400;
const GRID_Y = 420;
export const DEFAULT_NODE_WIDTH = 320;
export const DEFAULT_NODE_HEIGHT = 360;

function normalizeCanvasSize(
  size: { width?: unknown; height?: unknown } | undefined,
): { width: number; height: number } {
  const width =
    typeof size?.width === "number" &&
    Number.isFinite(size.width) &&
    size.width > 0
      ? size.width
      : DEFAULT_NODE_WIDTH;
  const height =
    typeof size?.height === "number" &&
    Number.isFinite(size.height) &&
    size.height > 0
      ? size.height
      : DEFAULT_NODE_HEIGHT;
  return { width, height };
}

/** Apply the fixed param schema to a canvas node restored from a draft. */
export function sanitizeFlowNode(node: RFNode): RFNode {
  if (!node.data?.workflow) {
    return node;
  }
  const size = normalizeCanvasSize({
    width: node.width,
    height: node.height,
  });
  return {
    ...node,
    width: size.width,
    height: size.height,
    data: {
      ...node.data,
      workflow: {
        ...node.data.workflow,
        params: sanitizeNodeParams(
          node.data.workflow.type,
          node.data.workflow.params,
        ),
      },
    },
  };
}

/** Build the deterministic edge id for a port-qualified connection. */
export function makeEdgeId(
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
): string {
  return `${source}::${sourcePort}::${target}::${targetPort}`;
}

/** Derive the deterministic id of an RF edge from its endpoints/handles. */
export function edgeIdOf(edge: RFEdge): string {
  return makeEdgeId(
    edge.source,
    edge.sourceHandle ?? "",
    edge.target,
    edge.targetHandle ?? "",
  );
}

/**
 * Convert a workflow definition into React Flow nodes/edges.
 *
 * Nodes without a stored canvas position get a deterministic grid layout
 * (`x = (i % 3) * 400`, `y = floor(i / 3) * 420`) and default dimensions;
 * the returned `positions` map contains the effective position for every node.
 */
export function definitionToFlow(def: WorkflowDefinition): FlowResult {
  const canvas = def.metadata.canvas as
    | {
        positions?: CanvasPositions;
        labels?: CanvasLabels;
        sizes?: CanvasSizes;
      }
    | undefined;
  const storedPositions = canvas?.positions ?? {};
  const storedLabels = canvas?.labels ?? {};
  const storedSizes = canvas?.sizes ?? {};

  const nodes: RFNode[] = def.nodes.map((node, index) => {
    const stored = storedPositions[node.id];
    const position = stored ?? {
      x: (index % GRID_COLUMNS) * GRID_X,
      y: Math.floor(index / GRID_COLUMNS) * GRID_Y,
    };
    const displayName = normalizeNodeDisplayName(
      node.type,
      storedLabels[node.id] ?? "",
    );
    const size = normalizeCanvasSize(storedSizes[node.id]);
    return {
      id: node.id,
      type: node.type,
      position: { ...position },
      width: size.width,
      height: size.height,
      data: {
        workflow: {
          ...node,
          params: sanitizeNodeParams(node.type, node.params),
        },
        ...(displayName ? { displayName } : {}),
      },
    };
  });

  const edges: RFEdge[] = def.edges.map((edge) => ({
    id: makeEdgeId(
      edge.source,
      edge.source_port,
      edge.target,
      edge.target_port,
    ),
    source: edge.source,
    sourceHandle: edge.source_port,
    target: edge.target,
    targetHandle: edge.target_port,
    ...(edge.condition != null ? { data: { condition: edge.condition } } : {}),
  }));

  const positions: PositionsMap = {};
  for (const node of nodes) {
    positions[node.id] = { ...node.position };
  }

  return { nodes, edges, positions };
}

/**
 * Convert React Flow nodes/edges back into a workflow definition.
 *
 * `base.def` supplies the parts that do not change with the canvas
 * (id/name/version and metadata), while nodes/edges come from the canvas.
 * Positions are collected from the RF node `position` fields and merged into
 * `metadata.canvas.positions`, preserving any other metadata keys.
 */
export function flowToDefinition(
  { nodes, edges }: { nodes: RFNode[]; edges: RFEdge[] },
  base: { def: WorkflowDefinition; positions: PositionsMap },
): { definition: WorkflowDefinition; metadata: WorkflowMetadata } {
  const workflowNodes: WorkflowNode[] = nodes.map((node) => {
    if (node.data?.workflow) {
      // data.workflow is already the clean definition node. Sanitizing here
      // (and in definitionToFlow) is the single compatibility policy for
      // legacy/custom params: they are deleted, never preserved untyped.
      return {
        ...node.data.workflow,
        params: sanitizeNodeParams(
          node.data.workflow.type,
          node.data.workflow.params,
        ),
      };
    }
    // Fresh canvas node without a workflow payload: rebuild defaults by type,
    // keeping the id the canvas already assigned. An unrecognised type fails
    // loudly through the catalog rather than silently dropping the node.
    return { ...getDefaultNode(node.type as NodeType), id: node.id };
  });

  const workflowEdges: WorkflowEdge[] = edges.map((edge) => ({
    source: edge.source,
    source_port: edge.sourceHandle ?? "",
    target: edge.target,
    target_port: edge.targetHandle ?? "",
    ...(edge.data?.condition != null ? { condition: edge.data.condition } : {}),
  }));

  const collected: CanvasPositions = {};
  const labels: CanvasLabels = {};
  const sizes: CanvasSizes = {};
  for (const node of nodes) {
    collected[node.id] = { x: node.position.x, y: node.position.y };
    sizes[node.id] = normalizeCanvasSize({
      width: node.width,
      height: node.height,
    });
    const displayName = normalizeNodeDisplayName(
      node.type as NodeType,
      node.data?.displayName ?? "",
    );
    if (displayName) {
      labels[node.id] = displayName;
    }
  }
  const baseCanvas = base.def.metadata.canvas as
    | {
        positions?: CanvasPositions;
        labels?: CanvasLabels;
        sizes?: CanvasSizes;
      }
    | undefined;
  const metadata: WorkflowMetadata = {
    ...base.def.metadata,
    canvas: {
      ...baseCanvas,
      positions: { ...base.positions, ...collected },
      labels,
      sizes,
    },
  };

  const definition: WorkflowDefinition = {
    ...base.def,
    nodes: workflowNodes,
    edges: workflowEdges,
    metadata,
  };

  return { definition, metadata };
}
