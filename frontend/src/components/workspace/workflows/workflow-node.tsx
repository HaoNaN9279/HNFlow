"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import {
  Node,
  NodeContent,
  NodeDescription,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import { getNodeCatalogEntry } from "@/core/workflows/canvas/node-catalog";
import type { NodeRunState } from "@/core/workflows/run-state";
import type { PortType } from "@/core/workflows/types";
import { cn } from "@/lib/utils";

import { useWorkflowEditor } from "./workflow-editor-context";

export type WorkflowNodeProps = NodeProps<RFNode>;

/** Handle fill by port type so connection targets are scannable at a glance. */
const PORT_HANDLE_COLORS: Record<PortType, string> = {
  data: "var(--primary)",
  file: "#d97706",
  bool: "#16a34a",
  enum: "#7c3aed",
  number: "#0891b2",
  array: "#db2777",
  record: "#65a30d",
};

/** Vertical offset of the first port row inside the node (below the header). */
const PORT_ROW_TOP = 44;
const PORT_ROW_GAP = 20;

/**
 * Custom React Flow node for workflow steps. Renders the catalog label plus
 * one `Handle` per input (left / target) and output (right / source), each
 * carrying the port name as its handle id so connections round-trip through
 * `flowToDefinition`.
 *
 * Error state comes from the shared editor context: any backend 422 error that
 * references this node id adds `data-error="true"` and a destructive border,
 * which E2E tests assert on.
 *
 * The per-node runtime state (T16) is painted from `runState.nodeStates`:
 * running gets an amber ring, completed a green border, failed the destructive
 * colour. A validation error keeps its own `data-error` attribute; when a node
 * is both invalid and failed the destructive border wins, so the two states
 * never fight visually.
 */

/** Border/ring tint per per-node runtime state (idle keeps the default). */
function runStateClasses(
  state: NodeRunState,
  hasValidationError: boolean,
): string | undefined {
  if (hasValidationError || state === "failed") {
    return "border-destructive/70";
  }
  if (state === "running") {
    return "border-amber-400 ring-2 ring-amber-400/40";
  }
  if (state === "completed") {
    return "border-emerald-600/70";
  }
  return undefined;
}

export function WorkflowNode({ id, data, selected }: WorkflowNodeProps) {
  const workflow = data.workflow;
  const entry = getNodeCatalogEntry(workflow.type);
  const { errors, runState } = useWorkflowEditor();
  const hasError = errors.some(
    (error) => error.type === "node" && error.id === id,
  );
  const runStateOfNode = runState.nodeStates[id] ?? "idle";

  return (
    <Node
      handles={{ target: false, source: false }}
      data-node-type={workflow.type}
      data-error={hasError ? "true" : undefined}
      data-run-state={runStateOfNode}
      className={cn(
        "min-w-44",
        selected && "ring-ring ring-2",
        runStateClasses(runStateOfNode, hasError),
      )}
    >
      <NodeHeader>
        <NodeTitle className="text-sm">
          {entry?.label ?? workflow.type}
        </NodeTitle>
        {entry?.description && (
          <NodeDescription className="line-clamp-1 text-xs">
            {entry.description}
          </NodeDescription>
        )}
      </NodeHeader>
      <NodeContent className="flex flex-col gap-1 p-2">
        {workflow.inputs.map((port, index) => (
          <div key={port.name} className="relative flex items-center">
            <Handle
              type="target"
              id={port.name}
              position={Position.Left}
              style={{
                top: `${PORT_ROW_TOP + index * PORT_ROW_GAP}px`,
                backgroundColor: PORT_HANDLE_COLORS[port.type],
              }}
            />
            <span className="text-muted-foreground ml-2.5 text-xs">
              {port.name}
            </span>
          </div>
        ))}
        {workflow.outputs.map((port, index) => (
          <div
            key={port.name}
            className="relative flex items-center justify-end"
          >
            <span className="text-muted-foreground mr-2.5 text-xs">
              {port.name}
            </span>
            <Handle
              type="source"
              id={port.name}
              position={Position.Right}
              style={{
                top: `${PORT_ROW_TOP + index * PORT_ROW_GAP}px`,
                backgroundColor: PORT_HANDLE_COLORS[port.type],
              }}
            />
          </div>
        ))}
      </NodeContent>
    </Node>
  );
}
