"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import { fetchWorkflowRunState } from "@/core/workflows/api";
import {
  continueDebugPause,
  fetchPendingHumanTasks,
  pendingDebugPauses,
  pendingHumanTasks,
  skipHumanTask,
  type DebugPause,
  type HumanTaskRecord,
} from "@/core/workflows/human-tasks";
import {
  extractNodeDurations,
  formatDuration,
  type NodeDurationReport,
} from "@/core/workflows/run-durations";
import type { RunStatus } from "@/core/workflows/run-state";
import { continueWorkflowNode, rewindWorkflowRun } from "@/core/workflows/runs";
import { cn } from "@/lib/utils";

import { useWorkflowEditor, useWorkflowRun } from "./workflow-editor-context";
import { WorkflowHumanTaskForm } from "./workflow-human-task-form";

/** Badge tint per overall run status, mirroring the workflow-list row badges. */
const RUN_STATUS_BADGE_CLASSES: Record<RunStatus, string> = {
  idle: "border-transparent bg-muted text-muted-foreground",
  running: "border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400",
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
 * Bottom run monitor for the workflow editor. Reads the run state from the
 * shared editor context and renders the node timeline (started/completed/failed
 * with output or error), the run-level error message and the terminal result.
 * The Run/Stop controls live in the toolbar; this panel is display-only.
 */
export function WorkflowRunPanel() {
  const { t } = useI18n();
  const { runState } = useWorkflowRun();
  const { definition, workflowId } = useWorkflowEditor();
  const labels = t.workflows.run;
  const [collapsed, setCollapsed] = useState(false);

  const isTerminal =
    runState.status !== "idle" && runState.status !== "running";
  const runId = runState.runId;

  // Continue is only meaningful for AI nodes: the backend resumes the node's
  // own session checkpoint (W2B continue_workflow_node).
  const aiNodeIds = useMemo(
    () =>
      new Set(
        definition.nodes
          .filter((node) => node.type === "ai:llm_agent")
          .map((node) => node.id),
      ),
    [definition],
  );

  const [continueTarget, setContinueTarget] = useState<string | null>(null);
  const [continuePrompt, setContinuePrompt] = useState("");
  const [continueSubmitting, setContinueSubmitting] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  // N14x: per-node durations come from the run's checkpoint channels (the
  // node-lifecycle events deliberately carry declared ports only). Fetched
  // imperatively — and only once a run has settled — so a panel that never ran
  // anything makes no request and the component needs no query provider.
  const [durationReport, setDurationReport] =
    useState<NodeDurationReport | null>(null);

  useEffect(() => {
    if (!isTerminal || runId == null || typeof fetch !== "function") {
      setDurationReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const channels = await fetchWorkflowRunState(workflowId, runId);
        if (!cancelled) {
          setDurationReport(extractNodeDurations(channels));
        }
      } catch {
        // The timing readout is observability, never a run failure.
        if (!cancelled) {
          setDurationReport(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isTerminal, runId, workflowId]);

  // §25 debug pauses (N14ae): a breakpoint / single-step suspension is a
  // pending human task, so the panel resolves it by submitting or skipping the
  // row. Fetched imperatively like the duration readout, but on failure it
  // reports "could not read" instead of silently claiming no pause — this is a
  // control, not observability.
  const [pauses, setPauses] = useState<DebugPause[]>([]);
  const [tasks, setTasks] = useState<HumanTaskRecord[]>([]);
  const [pausesLoadFailed, setPausesLoadFailed] = useState(false);
  const [pauseBusyId, setPauseBusyId] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const applyTasks = useCallback(
    (rows: HumanTaskRecord[]) => {
      setPauses(pendingDebugPauses(rows, { preferredRunId: runId }));
      // Everything else pending is a submission form (a ``human:task`` node or an
      // approval gate).  A rewind / resume admits a new run id, so these are
      // deliberately not scoped to the panel's own run — a paused approval must
      // stay reachable no matter which run started it.
      setTasks(pendingHumanTasks(rows, { preferredRunId: runId }));
    },
    [runId],
  );

  const loadPauses = useCallback(async () => {
    if (typeof fetch !== "function") {
      return;
    }
    try {
      const rows = await fetchPendingHumanTasks();
      applyTasks(rows);
      setPausesLoadFailed(false);
    } catch {
      setPausesLoadFailed(true);
    }
  }, [applyTasks]);

  useEffect(() => {
    if (!isTerminal || runId == null || typeof fetch !== "function") {
      setPauses([]);
      setTasks([]);
      setPausesLoadFailed(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchPendingHumanTasks();
        if (!cancelled) {
          applyTasks(rows);
          setPausesLoadFailed(false);
        }
      } catch {
        if (!cancelled) {
          setPauses([]);
          setTasks([]);
          setPausesLoadFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyTasks, isTerminal, runId]);

  const handlePauseAction = useCallback(
    async (pause: DebugPause, action: "continue" | "skip") => {
      setPauseBusyId(pause.id);
      setPauseError(null);
      try {
        if (action === "continue") {
          await continueDebugPause(pause.id);
          toast.success(labels.debugPause.continued);
        } else {
          await skipHumanTask(pause.id);
          toast.success(labels.debugPause.skipped);
        }
        // The resumed run is server-side and starts its own run id, so re-read
        // the pending rows rather than assuming this pause is gone.
        await loadPauses();
      } catch (error) {
        setPauseError(error instanceof Error ? error.message : String(error));
        toast.error(labels.debugPause.actionFailed);
      } finally {
        setPauseBusyId(null);
      }
    },
    [labels.debugPause, loadPauses],
  );

  // §25 rewind & re-run (N14ah): re-execute from one node onward. Offered only
  // for a settled run — the engine refuses a live one (it is still writing the
  // checkpoints a rewind replays).
  const [rewindBusyNode, setRewindBusyNode] = useState<string | null>(null);
  const { rewindFailed: rewindFailedLabel, rewindStarted: rewindStartedLabel } =
    labels;

  const handleRewind = useCallback(
    async (nodeId: string) => {
      if (runId == null) {
        return;
      }
      setRewindBusyNode(nodeId);
      try {
        const record = await rewindWorkflowRun(workflowId, runId, nodeId);
        toast.success(rewindStartedLabel(record.run_id));
      } catch (error) {
        toast.error(
          `${rewindFailedLabel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setRewindBusyNode(null);
      }
    },
    [rewindFailedLabel, rewindStartedLabel, runId, workflowId],
  );

  const handleContinue = async (nodeId: string) => {
    const prompt = continuePrompt.trim();
    if (!runId || prompt === "") {
      return;
    }
    setContinueSubmitting(true);
    setContinueError(null);
    try {
      const record = await continueWorkflowNode(
        workflowId,
        runId,
        nodeId,
        prompt,
      );
      toast.success(labels.continueStarted(record.run_id));
      setContinueTarget(null);
      setContinuePrompt("");
    } catch (error) {
      setContinueError(error instanceof Error ? error.message : String(error));
    } finally {
      setContinueSubmitting(false);
    }
  };

  return (
    <section
      className={cn(
        "flex w-full shrink-0 flex-col border-t",
        collapsed ? "h-12" : "h-64",
      )}
      data-testid="workflow-run-panel"
      data-collapsed={collapsed}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b px-4",
          collapsed ? "h-12" : "py-3",
        )}
      >
        <span className="text-sm font-medium">{labels.panel.title}</span>
        <div className="flex items-center gap-1.5">
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-expanded={!collapsed}
            aria-label={
              collapsed ? t.workflows.expandPanel : t.workflows.collapsePanel
            }
            title={
              collapsed ? t.workflows.expandPanel : t.workflows.collapsePanel
            }
            onClick={() => setCollapsed((current) => !current)}
            data-testid="workflow-run-toggle"
          >
            {collapsed ? (
              <ChevronUpIcon className="size-4" />
            ) : (
              <ChevronDownIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runState.status === "idle" ? (
            <div className="text-muted-foreground p-4 text-sm">
              {labels.panel.idleHint}
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              {(pauses.length > 0 || tasks.length > 0 || pausesLoadFailed) && (
                <div
                  className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
                  data-testid="workflow-debug-pauses"
                >
                  <span className="text-xs font-medium">
                    {labels.debugPause.title}
                  </span>
                  <p className="text-muted-foreground text-[11px]">
                    {labels.debugPause.hint}
                  </p>
                  {pausesLoadFailed && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-destructive text-[11px]">
                        {labels.debugPause.loadFailed}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-[11px]"
                        onClick={() => void loadPauses()}
                        data-testid="workflow-debug-retry"
                      >
                        {labels.debugPause.retry}
                      </Button>
                    </div>
                  )}
                  {pauses.map((pause) => (
                    <div
                      key={pause.id}
                      className="border-muted flex flex-col gap-1 rounded border p-1.5"
                      data-testid="workflow-debug-pause"
                      data-pause-id={pause.id}
                      data-pause-node={pause.nodeId}
                      data-pause-kind={pause.kind}
                      data-pause-run={pause.runId}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-mono">
                          {pause.nodeId}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          {pause.kind === "step"
                            ? labels.debugPause.step
                            : labels.debugPause.breakpoint}
                        </span>
                      </div>
                      <span
                        className="text-muted-foreground truncate font-mono text-[10px]"
                        title={pause.runId}
                      >
                        {labels.debugPause.runHint(pause.runId)}
                      </span>
                      {pause.description !== "" && (
                        <span className="text-muted-foreground text-[11px] break-words">
                          {pause.description}
                        </span>
                      )}
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={pauseBusyId !== null}
                          onClick={() =>
                            void handlePauseAction(pause, "continue")
                          }
                          data-testid="workflow-debug-continue"
                          data-pause-id={pause.id}
                        >
                          {labels.debugPause.continue}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={pauseBusyId !== null}
                          onClick={() => void handlePauseAction(pause, "skip")}
                          data-testid="workflow-debug-skip"
                          data-pause-id={pause.id}
                        >
                          {labels.debugPause.skip}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {pauseError != null && (
                    <span
                      className="text-destructive text-[11px] break-words"
                      data-testid="workflow-debug-error"
                    >
                      {pauseError}
                    </span>
                  )}
                  {tasks.map((task) => (
                    <WorkflowHumanTaskForm
                      key={task.id}
                      task={task}
                      onResolved={() => void loadPauses()}
                    />
                  ))}
                </div>
              )}

              {runState.timeline.length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium">
                    {labels.panel.timeline}
                  </div>
                  {durationReport?.slowest != null && (
                    <div
                      className="text-muted-foreground text-[11px]"
                      data-testid="workflow-run-slowest"
                      data-node={durationReport.slowest.nodeId}
                    >
                      {labels.panel.slowestNode}:{" "}
                      {durationReport.slowest.nodeId} ·{" "}
                      {formatDuration(durationReport.slowest.ms)}
                    </div>
                  )}
                  <ul className="flex flex-col gap-1.5">
                    {runState.timeline.map((entry, index) => {
                      const statusLabel = timelineStatusLabel(entry.status);
                      const hasOutput =
                        entry.output != null &&
                        Object.keys(entry.output).length > 0;
                      const duration = durationReport?.durations[entry.nodeId];
                      // Only the entry that actually finished reports the timing.
                      const showDuration =
                        duration != null &&
                        (entry.status === "completed" ||
                          entry.status === "failed");
                      return (
                        <li
                          key={`${entry.nodeId}-${entry.step}-${entry.status}-${index}`}
                          className="border-muted flex flex-col gap-0.5 rounded-md border p-2"
                          data-timeline-status={entry.status}
                          data-timeline-node={entry.nodeId}
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-mono">
                              {entry.nodeId}
                            </span>
                            <span className="flex items-center gap-1">
                              {showDuration && (
                                <span
                                  className="text-muted-foreground font-mono text-[11px]"
                                  data-testid="workflow-run-node-duration"
                                  data-node={entry.nodeId}
                                >
                                  {formatDuration(duration)}
                                </span>
                              )}
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-0.5 text-[11px]",
                                  timelineStatusClass(entry.status),
                                )}
                              >
                                {labels.nodeStatus[statusLabel]}
                              </span>
                            </span>
                          </div>
                          {isTerminal &&
                            runId != null &&
                            aiNodeIds.has(entry.nodeId) &&
                            (continueTarget === entry.nodeId ? (
                              <div
                                className="flex flex-col gap-1.5"
                                data-testid="workflow-run-continue-form"
                              >
                                <textarea
                                  className="bg-muted min-h-16 w-full resize-y rounded border p-1.5 font-mono text-[11px]"
                                  value={continuePrompt}
                                  onChange={(event) =>
                                    setContinuePrompt(event.target.value)
                                  }
                                  placeholder={labels.continuePromptPlaceholder}
                                  data-testid="workflow-run-continue-prompt"
                                />
                                {continueError != null && (
                                  <span
                                    className="text-destructive text-[11px]"
                                    data-testid="workflow-run-continue-error"
                                  >
                                    {continueError}
                                  </span>
                                )}
                                <div className="flex gap-1.5">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-1.5 text-[11px]"
                                    disabled={
                                      continueSubmitting ||
                                      continuePrompt.trim() === ""
                                    }
                                    onClick={() => handleContinue(entry.nodeId)}
                                    data-testid="workflow-run-continue-submit"
                                  >
                                    {labels.continuePromptSubmit}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-1.5 text-[11px]"
                                    disabled={continueSubmitting}
                                    onClick={() => {
                                      setContinueTarget(null);
                                      setContinuePrompt("");
                                      setContinueError(null);
                                    }}
                                  >
                                    {labels.continueCancel}
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-6 px-1.5 text-[11px]"
                                onClick={() => {
                                  setContinueTarget(entry.nodeId);
                                  setContinuePrompt("");
                                  setContinueError(null);
                                }}
                                data-testid="workflow-run-continue"
                                data-continue-node={entry.nodeId}
                              >
                                {labels.continueSession}
                              </Button>
                            ))}
                          {isTerminal && runId != null && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 self-start px-1.5 text-[11px]"
                              disabled={rewindBusyNode !== null}
                              title={labels.rewindHint}
                              onClick={() => void handleRewind(entry.nodeId)}
                              data-testid="workflow-run-rewind"
                              data-rewind-node={entry.nodeId}
                            >
                              {labels.rewind}
                            </Button>
                          )}
                          {entry.status === "completed" &&
                            (hasOutput ? (
                              <details className="text-muted-foreground text-xs">
                                <summary className="cursor-pointer">
                                  {labels.panel.output}
                                </summary>
                                <pre className="bg-muted mt-1 max-h-40 overflow-auto rounded p-1.5 font-mono text-[11px]">
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
                  className="bg-destructive/10 text-destructive border-destructive/30 flex flex-col gap-0.5 rounded-md border p-2 text-xs"
                  data-testid="workflow-run-error"
                >
                  <span className="font-medium">
                    {labels.panel.errorDetail}
                  </span>
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
        </div>
      )}
    </section>
  );
}
