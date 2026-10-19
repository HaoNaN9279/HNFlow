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
import type { Port, PortType } from "@/core/workflows/types";
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

function formatParamValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** One port row.  The handle is centered on this row, never offset by a
 *  hard-coded header height — that offset is what pushed slots outside the
 *  node when the header/param area grew. */
function PortRow({
  port,
  side,
  last,
}: {
  port: Port;
  side: "input" | "output";
  last: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-6 items-center gap-1.5 text-xs",
        side === "output" && "justify-end text-right",
        !last && "mb-1",
      )}
    >
      <Handle
        type={side === "input" ? "target" : "source"}
        id={port.name}
        position={side === "input" ? Position.Left : Position.Right}
        style={{
          top: "50%",
          transform: "translateY(-50%)",
          backgroundColor: PORT_HANDLE_COLORS[port.type],
        }}
      />
      <span
        className={cn(
          "truncate",
          side === "input" ? "ml-2" : "mr-2",
          port.required ? "text-foreground" : "text-muted-foreground",
        )}
        title={`${port.name}: ${port.type}`}
      >
        {port.name}
      </span>
      <span className="text-muted-foreground/70 font-mono text-[10px]">
        {port.type}
      </span>
    </div>
  );
}

/**
 * Custom React Flow node for workflow steps.
 *
 * ComfyUI-style: ports and every `params` entry are visible on the card, not
 * only in the inspector.  Values scroll inside a bounded body so a long
 * instruction cannot push the node (or its handles) out of its own box.
 */
export function WorkflowNode({ id, data, selected }: WorkflowNodeProps) {
  const workflow = data.workflow;
  const entry = getNodeCatalogEntry(workflow.type);
  const { errors, runState } = useWorkflowEditor();
  const hasError = errors.some(
    (error) => error.type === "node" && error.id === id,
  );
  const runStateOfNode = runState.nodeStates[id] ?? "idle";
  const lastCompleted = [...runState.timeline]
    .reverse()
    .find((item) => item.nodeId === id && item.status === "completed");
  const previewText =
    workflow.type === "ai:prompt_preview" &&
    typeof lastCompleted?.output?.prompt === "string"
      ? lastCompleted.output.prompt
      : null;
  const paramEntries = Object.entries(workflow.params);

  return (
    <Node
      handles={{ target: false, source: false }}
      data-node-type={workflow.type}
      data-error={hasError ? "true" : undefined}
      data-run-state={runStateOfNode}
      className={cn(
        "w-72 max-w-72 min-w-72 gap-0",
        selected && "ring-ring ring-2",
        runStateClasses(runStateOfNode, hasError),
      )}
    >
      <NodeHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <NodeTitle className="text-sm">
            {entry?.label ?? workflow.type}
          </NodeTitle>
          {entry?.description && (
            <NodeDescription className="line-clamp-2 text-[11px]">
              {entry.description}
            </NodeDescription>
          )}
        </div>
      </NodeHeader>
      <NodeContent className="flex min-h-0 flex-col gap-2 p-2">
        <div className="grid grid-cols-2 gap-x-3">
          <div className="min-w-0">
            {workflow.inputs.map((port, index) => (
              <PortRow
                key={port.name}
                port={port}
                side="input"
                last={index === workflow.inputs.length - 1}
              />
            ))}
          </div>
          <div className="min-w-0">
            {workflow.outputs.map((port, index) => (
              <PortRow
                key={port.name}
                port={port}
                side="output"
                last={index === workflow.outputs.length - 1}
              />
            ))}
          </div>
        </div>

        {previewText !== null && (
          <div className="flex flex-col gap-1 border-t pt-2">
            <div className="text-muted-foreground text-[10px] font-medium uppercase">
              Prompt
            </div>
            <pre className="bg-muted/50 max-h-56 overflow-auto rounded p-2 font-mono text-[10px] break-words whitespace-pre-wrap">
              {previewText || "—"}
            </pre>
          </div>
        )}

        {paramEntries.length > 0 && (
          <div className="flex flex-col gap-1 border-t pt-2">
            <div className="text-muted-foreground text-[10px] font-medium uppercase">
              Params
            </div>
            <div className="max-h-44 overflow-auto">
              {paramEntries.map(([key, value]) => {
                const text = formatParamValue(value);
                return (
                  <div
                    key={key}
                    className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] gap-2 py-0.5 text-[10px]"
                  >
                    <span
                      className="text-muted-foreground truncate font-mono"
                      title={key}
                    >
                      {key}
                    </span>
                    <span
                      className="break-words whitespace-pre-wrap"
                      title={text}
                    >
                      {text || "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </NodeContent>
    </Node>
  );
}
