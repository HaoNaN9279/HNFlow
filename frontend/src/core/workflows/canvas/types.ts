/**
 * Canvas-layer types — re-export the T14-1 domain types from
 * `@/core/workflows/types` (backend `deerflow.workflow.schema` mirror) and add
 * the canvas-only shapes (category, positions, node payload) on top.
 *
 * The workflow domain keeps a single source of truth in `types.ts`; this module
 * only narrows/extended it where the canvas needs more structure.
 */

import type { WorkflowMetadata as WorkflowMetadataBase } from "@/core/workflows/types";

export type {
  Edge as WorkflowEdge,
  Node as WorkflowNode,
  NodeType,
  Port,
  PortType,
  WorkflowDefinition,
} from "@/core/workflows/types";

/** Palette grouping for a node catalog entry. */
export type NodeCategory =
  | "flow"
  | "data"
  | "tool"
  | "ai"
  | "human"
  | "subworkflow";

/** NodeId → canvas coordinates, stored at `metadata.canvas.positions`. */
export type CanvasPositions = Record<string, { x: number; y: number }>;

/** Workflow metadata with the canvas position block typed. */
export type WorkflowMetadata = WorkflowMetadataBase & {
  canvas?: { positions?: CanvasPositions };
};
