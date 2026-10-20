"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/i18n/hooks";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import { usePersistedBoolean } from "@/hooks/use-persisted-toggle";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { cn } from "@/lib/utils";

import { WorkflowNodeForm } from "./workflow-node-form";
import {
  applyDraftRow,
  applyRemoveRow,
  paramsToDraft,
  serializeParamValue,
  type ParamDraftRow,
} from "./workflow-properties-panel-helpers";

/** Params owned by the typed node forms — hidden from the generic editor. */
const TYPED_NODE_TYPES = new Set([
  "ai:llm_agent",
  "ai:capability_group",
  "ai:prompt_preview",
  "nested:subworkflow",
]);
const TYPED_PARAM_KEYS = [
  "instruction",
  "subworkflow",
  "groups",
  "agent_node",
] as const;

type WorkflowPropertiesPanelProps = {
  node: RFNode | null;
  readonly?: boolean;
  onUpdateNodeParams: (nodeId: string, params: Record<string, unknown>) => void;
  /**
   * Full-node write-back for the typed node forms (agent_name,
   * capability_groups and params together). Optional: when absent the typed
   * form zone is skipped and the panel stays a generic key/value editor.
   */
  onUpdateNode?: (nodeId: string, next: WorkflowNode) => void;
  onDeleteNode: (nodeId: string) => void;
};

/**
 * Right-hand inspector for the selected canvas node: read-only id/type/ports,
 * a key/value JSON editor for `params` (committed on blur), and a delete-node
 * action that also removes the node's edges.
 */
export function WorkflowPropertiesPanel({
  node,
  readonly = false,
  onUpdateNodeParams,
  onUpdateNode,
  onDeleteNode,
}: WorkflowPropertiesPanelProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const workflow = node?.data?.workflow;
  const nodeId = node?.id ?? null;

  const [draft, setDraft] = useState<ParamDraftRow[]>([]);
  const [collapsed, setCollapsed] = usePersistedBoolean(
    "deerflow.ui.workflow.properties.collapsed",
    false,
  );
  const { size: panelWidth, handleProps } = useResizablePanel({
    storageKey: "deerflow.ui.workflow.properties.width",
    defaultSize: 288,
    min: 200,
    max: 720,
    axis: "x",
  });
  const nextRowIdRef = useRef(0);

  // Re-seed the draft only when the selected node changes, so edits in
  // progress survive parent re-renders (including background refetches).
  useEffect(() => {
    setDraft(
      workflow
        ? paramsToDraft(
            workflow.params,
            TYPED_NODE_TYPES.has(workflow.type) ? TYPED_PARAM_KEYS : [],
          )
        : [],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const resizeHandle = !collapsed && (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.workflows.resizePanel}
      tabIndex={0}
      className="hover:bg-primary/30 focus-visible:bg-primary/30 absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none focus-visible:outline-none"
      data-testid="workflow-properties-resize"
      {...handleProps}
    />
  );

  const header = (
    <div
      className={cn(
        "flex items-center gap-2 border-b",
        collapsed ? "justify-center p-2" : "px-4 py-3",
      )}
    >
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {labels.title}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-expanded={!collapsed}
        aria-label={
          collapsed ? t.workflows.expandPanel : t.workflows.collapsePanel
        }
        title={collapsed ? t.workflows.expandPanel : t.workflows.collapsePanel}
        onClick={() => setCollapsed((current) => !current)}
        data-testid="workflow-properties-toggle"
      >
        {collapsed ? (
          <ChevronLeftIcon className="size-4" />
        ) : (
          <ChevronRightIcon className="size-4" />
        )}
      </Button>
    </div>
  );

  if (!node || !workflow) {
    return (
      <aside
        className="relative flex shrink-0 flex-col border-l"
        style={{ width: collapsed ? 48 : panelWidth }}
        data-testid="workflow-properties-panel"
        data-collapsed={collapsed}
      >
        {resizeHandle}
        {header}
        {!collapsed && (
          <div className="text-muted-foreground p-4 text-sm">
            {labels.noSelection}
          </div>
        )}
      </aside>
    );
  }

  const updateRow = (index: number, patch: Partial<ParamDraftRow>) => {
    setDraft((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const commitRow = (index: number) => {
    const row = draft[index];
    if (!row) {
      return;
    }
    const result = applyDraftRow(workflow.params, row);
    if (result.ok) {
      onUpdateNodeParams(node.id, result.params);
      return;
    }
    // Invalid JSON or a blank key on an existing row: restore the stored value
    // so the panel never silently diverges from the node. Freshly added rows
    // (not yet in params) keep their draft so the user can keep typing.
    if (row.id in workflow.params) {
      const restored = serializeParamValue(workflow.params[row.id]);
      setDraft((current) =>
        current.map((r, i) => (i === index ? { ...r, value: restored } : r)),
      );
    }
  };

  const addRow = () => {
    nextRowIdRef.current += 1;
    setDraft((current) => [
      ...current,
      { id: `new-${nextRowIdRef.current}`, key: "", value: "" },
    ]);
  };

  const removeRow = (index: number) => {
    const row = draft[index];
    if (!row) {
      return;
    }
    if (row.id in workflow.params) {
      onUpdateNodeParams(node.id, applyRemoveRow(workflow.params, row.id));
    }
    setDraft((current) => current.filter((_, i) => i !== index));
  };

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l"
      style={{ width: collapsed ? 48 : panelWidth }}
      data-testid="workflow-properties-panel"
      data-collapsed={collapsed}
    >
      {resizeHandle}
      {header}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-1">
              <div className="text-xs">
                <span className="text-muted-foreground">
                  {labels.nodeIdLabel}:{" "}
                </span>
                <span className="font-mono">{node.id}</span>
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground">
                  {labels.nodeTypeLabel}:{" "}
                </span>
                <span className="font-mono">{workflow.type}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium">{labels.portsTitle}</div>
              {workflow.inputs.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  <div className="text-muted-foreground text-[11px]">
                    {labels.inputs}
                  </div>
                  {workflow.inputs.map((port) => (
                    <div
                      key={port.name}
                      className="text-muted-foreground flex items-center justify-between text-xs"
                    >
                      <span>{port.name}</span>
                      <span className="font-mono">{port.type}</span>
                    </div>
                  ))}
                </div>
              )}
              {workflow.outputs.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  <div className="text-muted-foreground text-[11px]">
                    {labels.outputs}
                  </div>
                  {workflow.outputs.map((port) => (
                    <div
                      key={port.name}
                      className="text-muted-foreground flex items-center justify-between text-xs"
                    >
                      <span>{port.name}</span>
                      <span className="font-mono">{port.type}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {onUpdateNode && (
              <WorkflowNodeForm
                node={node}
                readonly={readonly}
                onChange={(next) => onUpdateNode(node.id, next)}
              />
            )}

            {/*
          §25 debugging: an explicit breakpoint toggle. It writes the same
          ``params.breakpoint`` the compiler's gate reads, so the canvas and a
          hand-written definition agree — the generic params editor below can
          still set it, this just makes the intent discoverable (and clears the
          key when switched off instead of leaving `breakpoint: false` behind).
        */}
            <label
              className="flex items-center gap-2 text-xs"
              title={labels.breakpointHint}
            >
              <input
                type="checkbox"
                checked={workflow.params.breakpoint === true}
                disabled={readonly}
                onChange={(event) => {
                  const next = { ...workflow.params };
                  if (event.target.checked) {
                    next.breakpoint = true;
                  } else {
                    delete next.breakpoint;
                  }
                  onUpdateNodeParams(node.id, next);
                }}
                aria-label={labels.breakpointLabel}
                data-testid="workflow-breakpoint-toggle"
              />
              <span>{labels.breakpointLabel}</span>
            </label>

            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium">{labels.paramsTitle}</div>
              {draft.map((row, index) => (
                <div key={row.id} className="flex items-center gap-1">
                  <Input
                    value={row.key}
                    disabled={readonly}
                    aria-label={`${labels.paramKey} ${index + 1}`}
                    onChange={(event) =>
                      updateRow(index, { key: event.target.value })
                    }
                    onBlur={() => commitRow(index)}
                    className="h-7 w-20 text-xs"
                  />
                  <Input
                    value={row.value}
                    disabled={readonly}
                    aria-label={`${labels.paramValue} ${index + 1}`}
                    onChange={(event) =>
                      updateRow(index, { value: event.target.value })
                    }
                    onBlur={() => commitRow(index)}
                    className="h-7 min-w-0 flex-1 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={readonly}
                    onClick={() => removeRow(index)}
                    aria-label={`${labels.removeParam} ${row.key || index + 1}`}
                    title={labels.removeParam}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readonly}
                onClick={addRow}
              >
                <PlusIcon className="size-3.5" />
                {labels.addParam}
              </Button>
            </div>

            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={readonly}
              onClick={() => onDeleteNode(node.id)}
            >
              {labels.deleteNode}
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}
