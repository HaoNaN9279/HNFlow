"use client";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/core/i18n/hooks";
import type { RunStatus } from "@/core/workflows/run-state";
import { cn } from "@/lib/utils";

import { useWorkflowRun } from "./workflow-editor-context";

/** Badge tint per overall run status, mirroring the workflow-list row badges. */
const RUN_STATUS_BADGE_CLASSES: Record<RunStatus, string> = {
  idle: "border-transparent bg-muted text-muted-foreground",
  running:
    "border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400",
  success:
    "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  error: "border-transparent bg-destructive/10 text-destructive",
  timeout:
    "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  interrupted: "border-transparent bg-muted text-muted-foreground",
};

/** Timeline-entry status label + tint for one node step. */
function timelineStatusClass(status: "started" | "completed" | "failed") {
  switch (status) {
    case "started":
      return "border-amber-500/10 bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "completed":
      return "border-emerald-500/10 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
  }
}

/** Map a timeline step status onto the shared node-status label. */
function timelineStatusLabel(
  status: "started" | "completed" | "failed",
): "running" | "completed" | "failed" {
  return status === "started" ? "running" : status;
}

/**
 * Right-hand run monitor for the workflow editor. Reads the run state from the
 * shared editor context and renders the node timeline (started/completed/failed
 * with output or error), the run-level error message and the terminal result.
 * The Run/Stop controls live in the toolbar; this panel is display-only.
 */
export function WorkflowRunPanel() {
  const { t } = useI18n();
  const { runState } = useWorkflowRun();
  const labels = t.workflows.run;

  const isTerminal =
    runState.status !== "idle" && runState.status !== "running";

  return (
    <aside
      className="w-[260px] shrink-0 overflow-y-auto border-l"
      data-testid="workflow-run-panel"
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">{labels.panel.title}</span>
        {runState.status !== "idle" && (
          <Badge
            variant="outline"
            className={RUN_STATUS_BADGE_CLASSES[runState.status]}
            data-testid="workflow-run-badge"
            data-status={runState.status}
          >
            {labels.runStatus[runState.status]}
          </Badge>
        )}
      </div>

      {runState.status === "idle" ? (
        <div className="text-muted-foreground p-4 text-sm">
          {labels.panel.idleHint}
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {runState.timeline.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium">{labels.panel.timeline}</div>
              <ul className="flex flex-col gap-1.5">
                {runState.timeline.map((entry, index) => {
                  const statusLabel = timelineStatusLabel(entry.status);
                  const hasOutput =
                    entry.output != null &&
                    Object.keys(entry.output).length > 0;
                  return (
                    <li
                      key={`${entry.nodeId}-${entry.step}-${entry.status}-${index}`}
                      className="border-muted flex flex-col gap-0.5 rounded-md border p-2"
                      data-timeline-status={entry.status}
                      data-timeline-node={entry.nodeId}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono truncate">
                          {entry.nodeId}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[11px]",
                            timelineStatusClass(entry.status),
                          )}
                        >
                          {labels.nodeStatus[statusLabel]}
                        </span>
                      </div>
                      {entry.status === "completed" &&
                        (hasOutput ? (
                          <details className="text-muted-foreground text-xs">
                            <summary className="cursor-pointer">
                              {labels.panel.output}
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px]">
                              {JSON.stringify(entry.output, null, 2)}
                            </pre>
                          </details>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">
                            {labels.panel.noOutput}
                          </span>
                        ))}
                      {entry.error != null && entry.error !== "" && (
                        <span className="text-destructive text-[11px]">
                          {entry.error}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {runState.errorMessage != null && (
            <div
              className="bg-destructive/10 text-destructive flex flex-col gap-0.5 rounded-md border border-destructive/30 p-2 text-xs"
              data-testid="workflow-run-error"
            >
              <span className="font-medium">{labels.panel.errorDetail}</span>
              <p className="break-words">{runState.errorMessage}</p>
            </div>
          )}

          {isTerminal && (
            <div
              className="flex items-center justify-between gap-2 text-sm"
              data-testid="workflow-run-terminal"
            >
              <span className="text-muted-foreground text-xs">
                {labels.panel.terminalStatus}
              </span>
              <span className="font-medium">
                {labels.runStatus[runState.status]}
              </span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
