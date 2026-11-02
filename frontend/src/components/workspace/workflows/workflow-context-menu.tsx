"use client";

import { useEffect, type ReactNode } from "react";

import { useI18n } from "@/core/i18n/hooks";
import { cn } from "@/lib/utils";

export type WorkflowContextMenuState = {
  x: number;
  y: number;
  /** `null` means the menu was opened on empty canvas space. */
  nodeId: string | null;
};

type WorkflowContextMenuProps = {
  state: WorkflowContextMenuState;
  canPaste: boolean;
  /** Current save mode when the target is a `nested:subworkflow` node. */
  subworkflowMode: "global" | "local" | null;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onSetSubworkflowMode: (mode: "global" | "local") => void;
  onClose: () => void;
};

/** Cursor-anchored node menu (copy/cut/paste), rendered above the canvas. */
export function WorkflowContextMenu({
  state,
  canPaste,
  subworkflowMode,
  onCopy,
  onCut,
  onPaste,
  onSetSubworkflowMode,
  onClose,
}: WorkflowContextMenuProps) {
  const { t } = useI18n();
  const labels = t.workflows.contextMenu;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const left =
    typeof window === "undefined"
      ? state.x
      : Math.min(state.x, window.innerWidth - 176);
  const top =
    typeof window === "undefined"
      ? state.y
      : Math.min(state.y, window.innerHeight - 240);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        aria-hidden="true"
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className="bg-popover text-popover-foreground fixed z-50 min-w-40 rounded-md border p-1 shadow-md"
        style={{ left, top }}
        role="menu"
        data-testid="workflow-context-menu"
        onContextMenu={(event) => event.preventDefault()}
      >
        {state.nodeId != null && (
          <>
            <MenuItem onClick={onCopy} testId="context-menu-copy">
              {labels.copy}
            </MenuItem>
            <MenuItem onClick={onCut} testId="context-menu-cut">
              {labels.cut}
            </MenuItem>
          </>
        )}
        {state.nodeId != null && subworkflowMode != null && (
          <>
            <div className="bg-border my-1 h-px" role="separator" />
            <MenuItem
              onClick={() => onSetSubworkflowMode("global")}
              testId="context-menu-subworkflow-global"
            >
              {subworkflowMode === "global" ? "✓ " : ""}
              {labels.subworkflowGlobal}
            </MenuItem>
            <MenuItem
              onClick={() => onSetSubworkflowMode("local")}
              testId="context-menu-subworkflow-local"
            >
              {subworkflowMode === "local" ? "✓ " : ""}
              {labels.subworkflowLocal}
            </MenuItem>
          </>
        )}
        <MenuItem
          onClick={onPaste}
          disabled={!canPaste}
          testId="context-menu-paste"
        >
          {labels.paste}
        </MenuItem>
      </div>
    </>
  );
}

function MenuItem({
  onClick,
  disabled = false,
  testId,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "hover:bg-accent focus-visible:ring-ring flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      {children}
    </button>
  );
}
