"use client";

import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { PauseIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Node,
  NodeContent,
  NodeDescription,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import {
  getDefaultNodeName,
  getNodeCatalogEntry,
} from "@/core/workflows/canvas/node-catalog";
import {
  readSubworkflowSaveMode,
  readSubworkflowSource,
} from "@/core/workflows/canvas/subworkflow";
import type { WorkflowNode as WorkflowNodeModel } from "@/core/workflows/canvas/types";
import type { Port, PortType } from "@/core/workflows/types";
import { cn } from "@/lib/utils";

import { useOpenSubworkflow } from "./use-open-subworkflow";
import { useWorkflowEditor } from "./workflow-editor-context";
import { WorkflowNodeForm } from "./workflow-node-form";

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
 *  hard-coded header height —that offset is what pushed slots outside the
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
  const name = (
    <span
      className={cn(
        "pointer-events-none truncate",
        side === "input" ? "ml-2" : "mr-2",
        port.required ? "text-foreground" : "text-muted-foreground",
      )}
      title={`${port.name}: ${port.type}`}
    >
      {port.name}
    </span>
  );
  const type = (
    <span className="text-muted-foreground/70 pointer-events-none font-mono text-[10px]">
      {port.type}
    </span>
  );

  return (
    <div
      className={cn(
        "relative flex min-h-6 items-center gap-1.5 text-xs",
        side === "output" && "justify-end text-right",
        !last && "mb-1",
      )}
      data-testid={`workflow-port-${side}-${port.name}`}
    >
      <Handle
        type={side === "input" ? "target" : "source"}
        id={port.name}
        position={side === "input" ? Position.Left : Position.Right}
        className="z-10"
        style={{
          top: "50%",
          transform: "translateY(-50%)",
          backgroundColor: PORT_HANDLE_COLORS[port.type],
        }}
      />
      {side === "input" ? (
        <>
          {name}
          {type}
        </>
      ) : (
        <>
          {type}
          {name}
        </>
      )}
    </div>
  );
}

/** Button-only child so ordinary nodes never mount navigation hooks. */
function OpenSubworkflowButton({ workflow }: { workflow: WorkflowNodeModel }) {
  const { t } = useI18n();
  const openSubworkflow = useOpenSubworkflow();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="nodrag nopan w-full"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        openSubworkflow(workflow);
      }}
      data-testid="workflow-node-open-subworkflow"
    >
      {t.workflows.properties.subworkflow.openButton}
    </Button>
  );
}

/**
 * Custom React Flow node for workflow steps.
 *
 * There is no inspector: ports, actions and params live on the card. Unselected
 * cards show a compact read-only summary; the selected card expands the fixed
 * schema-driven form. The card body scrolls inside the user-resized dimensions
 * so long instructions cannot push the handles out of their own box.
 */
export function WorkflowNode({ id, data, selected }: WorkflowNodeProps) {
  const { t } = useI18n();
  const workflow = data.workflow;
  const entry = getNodeCatalogEntry(workflow.type);
  const defaultName = getDefaultNodeName(workflow.type);
  const displayName = data.displayName?.trim() ?? defaultName;
  const subworkflowSource = readSubworkflowSource(workflow.params);
  const subworkflowMode = readSubworkflowSaveMode(workflow.params);
  const {
    errors,
    readonly,
    updateNode,
    updateNodeParams,
    deleteNode,
    updateNodeDisplayName,
    markDirty,
  } = useWorkflowEditor();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingName) {
      setNameDraft(displayName);
    }
  }, [displayName, editingName]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  const commitDisplayName = () => {
    if (!editingName) {
      return;
    }
    updateNodeDisplayName(id, nameDraft);
    setEditingName(false);
  };

  const hasError = errors.some(
    (error) => error.type === "node" && error.id === id,
  );
  const hasBreakpoint = workflow.params.breakpoint === true;
  const paramEntries = Object.entries(workflow.params);

  const toggleBreakpoint = () => {
    const params = { ...workflow.params };
    if (hasBreakpoint) {
      delete params.breakpoint;
    } else {
      params.breakpoint = true;
    }
    updateNodeParams(id, params);
  };

  return (
    <>
      <NodeResizer
        isVisible={selected && !readonly}
        minWidth={280}
        minHeight={220}
        maxWidth={720}
        maxHeight={960}
        onResizeEnd={markDirty}
      />
      <Node
        handles={{ target: false, source: false }}
        data-node-type={workflow.type}
        data-error={hasError ? "true" : undefined}
        data-subworkflow-mode={
          workflow.type === "nested:subworkflow" ? subworkflowMode : undefined
        }
        className={cn(
          "@container flex h-full w-full min-w-0 flex-col gap-0",
          selected && "ring-ring ring-2",
          workflow.type === "nested:subworkflow" &&
            (subworkflowMode === "local"
              ? "border-amber-200"
              : "border-zinc-400"),
          hasError && "border-destructive/70",
        )}
      >
        <NodeHeader className="flex shrink-0 flex-row items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <NodeTitle
              className={cn("text-sm", !readonly && "cursor-text")}
              title={readonly ? undefined : t.workflows.renameNodeHint}
              onDoubleClick={(event) => {
                if (readonly) {
                  return;
                }
                event.stopPropagation();
                setNameDraft(displayName);
                setEditingName(true);
              }}
            >
              {editingName ? (
                <input
                  ref={nameInputRef}
                  value={nameDraft}
                  data-testid="workflow-node-name-input"
                  aria-label={t.workflows.renameNodeHint}
                  className="nodrag nopan border-input bg-background focus-visible:ring-ring w-full rounded border px-1 text-sm font-semibold outline-none focus-visible:ring-1"
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={commitDisplayName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitDisplayName();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setNameDraft(displayName);
                      setEditingName(false);
                    }
                  }}
                />
              ) : (
                <span
                  className="block truncate"
                  data-testid="workflow-node-display-name"
                >
                  {displayName}
                </span>
              )}
            </NodeTitle>
            <div
              className="text-muted-foreground truncate text-xs"
              data-testid="workflow-node-default-name"
            >
              {defaultName}
            </div>
            <div
              className="text-muted-foreground truncate font-mono text-[10px]"
              data-testid="workflow-node-meta"
              title={`${workflow.type} 路 ${id}`}
            >
              {workflow.type} 路 {id}
            </div>
            {entry?.description && (
              <NodeDescription className="line-clamp-2 text-[11px]">
                {entry.description}
              </NodeDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant={hasBreakpoint ? "secondary" : "ghost"}
              size="icon-sm"
              className="nodrag nopan"
              disabled={readonly}
              aria-pressed={hasBreakpoint}
              aria-label={t.workflows.properties.breakpointLabel}
              title={t.workflows.properties.breakpointHint}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                toggleBreakpoint();
              }}
              data-testid="workflow-breakpoint-toggle"
            >
              <PauseIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="nodrag nopan text-muted-foreground hover:text-destructive"
              disabled={readonly}
              aria-label={t.workflows.properties.deleteNode}
              title={t.workflows.properties.deleteNode}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                deleteNode(id);
              }}
              data-testid="workflow-node-delete"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </NodeHeader>
        <NodeContent className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          {workflow.type === "nested:subworkflow" && subworkflowSource && (
            <OpenSubworkflowButton workflow={workflow} />
          )}
          <div className="grid grid-cols-1 gap-x-3 @[18rem]:grid-cols-2">
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

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {selected ? (
              <WorkflowNodeForm
                node={{ id, data }}
                readonly={readonly}
                active
                onChange={(next) => updateNode(id, next)}
              />
            ) : (
              paramEntries.length > 0 && (
                <div className="flex flex-col gap-1 border-t pt-2">
                  <div className="text-muted-foreground text-[10px] font-medium uppercase">
                    {t.workflows.properties.paramsTitle}
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
              )
            )}
          </div>
        </NodeContent>
      </Node>
    </>
  );
}
