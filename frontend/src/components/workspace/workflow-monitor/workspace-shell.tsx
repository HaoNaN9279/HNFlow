"use client";

import type { ReactNode } from "react";

import { GlobalWorkflowMonitor } from "./global-workflow-monitor";

/**
 * Workspace chrome that keeps the execution monitor mounted across route
 * changes.  ``children`` is the active page; the monitor is a sibling of the
 * page, not part of it.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      <GlobalWorkflowMonitor />
    </div>
  );
}
