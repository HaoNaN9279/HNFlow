"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import {
  continueDebugPause,
  fetchPendingHumanTasks,
  pendingDebugPauses,
  pendingHumanTasks,
  skipHumanTask,
  type DebugPause,
} from "@/core/workflows/human-tasks";
import { useMonitorRuns } from "@/core/workflows/workbench-hooks";
import { usePersistedBoolean } from "@/hooks/use-persisted-toggle";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { cn } from "@/lib/utils";

import { WorkflowHumanTaskForm } from "../workflows/workflow-human-task-form";

const STATUS_CLASSES: Record<string, string> = {
  pending: "border-transparent bg-muted text-muted-foreground",
  running: "border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400",
  waiting_human:
    "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  success:
    "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  error: "border-transparent bg-destructive/10 text-destructive",
  timeout:
    "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  interrupted: "border-transparent bg-muted text-muted-foreground",
};

function formatElapsed(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Workspace-level execution monitor.
 *
 * This component lives in the workspace shell, never in a page, so switching
 * left-sidebar destinations does not unmount it.  It is display-only for
 * execution: launching, stepping and cancelling belong to a workbench.  The
 * bottom section owns human decisions because those suspend a run and must be
 * reachable from anywhere.
 */
export function GlobalWorkflowMonitor() {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = usePersistedBoolean(
    "deerflow.ui.workflow-monitor.collapsed",
    false,
  );
  const { size, handleProps } = useResizablePanel({
    storageKey: "deerflow.ui.workflow-monitor.width",
    defaultSize: 340,
    min: 280,
    max: 480,
    axis: "x",
  });

  const runsQuery = useMonitorRuns({ status: "active" });
  const tasksQuery = useQuery({
    queryKey: ["human-tasks", "pending"],
    queryFn: fetchPendingHumanTasks,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const pauses = pendingDebugPauses(tasksQuery.data ?? []);
  const tasks = pendingHumanTasks(tasksQuery.data ?? []);
  const activeCount = runsQuery.data?.length ?? 0;
  const pendingCount = pauses.length + tasks.length;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["workflow-monitor-runs"] });
    void queryClient.invalidateQueries({
      queryKey: ["human-tasks", "pending"],
    });
  }, [queryClient]);

  const handlePause = useCallback(
    async (pause: DebugPause, action: "continue" | "skip") => {
      try {
        if (action === "continue") {
          await continueDebugPause(pause.id);
        } else {
          await skipHumanTask(pause.id);
        }
        refresh();
      } catch (error) {
        toast.error(
          `${t.runMonitor.actionFailed}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    [refresh, t.runMonitor.actionFailed],
  );

  if (collapsed) {
    return (
      <aside
        className="bg-background hidden h-full w-12 shrink-0 flex-col items-center border-l py-3 md:flex"
        data-testid="global-workflow-monitor-collapsed"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t.runMonitor.expand}
          title={t.runMonitor.expand}
          onClick={() => setCollapsed(false)}
          data-testid="workflow-monitor-expand"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <div className="relative mt-2">
          <ActivityIcon className="text-muted-foreground size-4" />
          {activeCount > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-2 -right-2 min-w-4 rounded-full px-1 text-center text-[10px] leading-4">
              {activeCount}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="absolute -right-2 -bottom-2 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 text-white">
              {pendingCount}
            </span>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="bg-background relative hidden h-full shrink-0 flex-col border-l md:flex"
      style={{ width: size }}
      data-testid="global-workflow-monitor"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t.runMonitor.resize}
        tabIndex={0}
        className="hover:bg-primary/30 focus-visible:bg-primary/30 absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none focus-visible:outline-none"
        data-testid="workflow-monitor-resize"
        {...handleProps}
      />

      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ActivityIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate text-sm font-medium">
            {t.runMonitor.title}
          </span>
          {activeCount > 0 && <Badge variant="outline">{activeCount}</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t.runMonitor.retry}
            title={t.runMonitor.retry}
            onClick={refresh}
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5",
                (runsQuery.isFetching || tasksQuery.isFetching) &&
                  "animate-spin",
              )}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t.runMonitor.collapse}
            title={t.runMonitor.collapse}
            onClick={() => setCollapsed(true)}
            data-testid="workflow-monitor-collapse"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {runsQuery.isLoading ? (
          <p className="text-muted-foreground p-2 text-xs">
            {t.runMonitor.loading}
          </p>
        ) : runsQuery.isError ? (
          <div className="flex flex-col gap-1 p-2">
            <p className="text-destructive text-xs">
              {t.runMonitor.loadFailed}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 self-start text-xs"
              onClick={() => void runsQuery.refetch()}
            >
              {t.runMonitor.retry}
            </Button>
          </div>
        ) : activeCount === 0 ? (
          <p className="text-muted-foreground p-2 text-xs">
            {t.runMonitor.empty}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {runsQuery.data?.map((run) => (
              <li key={run.run_id}>
                <button
                  type="button"
                  className="hover:bg-accent/50 flex w-full flex-col gap-1 rounded-md border p-2 text-left"
                  onClick={() => {
                    if (run.workbench_id) {
                      router.push(
                        `/workspace/workbenches/${encodeURIComponent(
                          run.workbench_id,
                        )}?run=${encodeURIComponent(run.run_id)}`,
                      );
                    }
                  }}
                  data-testid="workflow-monitor-run"
                  data-run-id={run.run_id}
                  data-status={run.display_state}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {run.definition_name ?? run.definition_id ?? run.run_id}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0",
                        STATUS_CLASSES[run.display_state] ??
                          STATUS_CLASSES.interrupted,
                      )}
                    >
                      {run.display_state === "waiting_human"
                        ? t.runMonitor.waitingHuman
                        : (t.workflows.run.runStatus[
                            run.status as keyof typeof t.workflows.run.runStatus
                          ] ?? run.status)}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
                    <span className="truncate">
                      {run.workbench_name ?? t.runMonitor.unassigned}
                    </span>
                    <span>·</span>
                    <span>{formatElapsed(run.elapsed_seconds)}</span>
                    {run.current_node && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{run.current_node}</span>
                      </>
                    )}
                    {run.completed_nodes != null && run.total_nodes != null && (
                      <>
                        <span>·</span>
                        <span>
                          {t.runMonitor.completed} {run.completed_nodes}/
                          {run.total_nodes}
                        </span>
                      </>
                    )}
                  </div>
                  {run.pending_human_task_count > 0 && (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400">
                      {t.workbenches.pendingHuman}:{" "}
                      {run.pending_human_task_count}
                    </span>
                  )}
                  {run.error_excerpt && (
                    <span className="text-destructive line-clamp-2 text-[11px]">
                      {run.error_excerpt}
                    </span>
                  )}
                  {run.workbench_id && (
                    <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
                      <ExternalLinkIcon className="size-3" />
                      {t.runMonitor.openWorkbench}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="flex max-h-[48%] min-h-0 shrink-0 flex-col border-t">
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs font-medium">
            {t.runMonitor.pendingTitle}
          </span>
          {pendingCount > 0 && (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            >
              {pendingCount}
            </Badge>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {tasksQuery.isLoading ? (
            <p className="text-muted-foreground p-1 text-xs">
              {t.runMonitor.loading}
            </p>
          ) : tasksQuery.isError ? (
            <div className="flex flex-col gap-1 p-1">
              <p className="text-destructive text-xs">
                {t.runMonitor.pendingLoadFailed}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 self-start text-xs"
                onClick={() => void tasksQuery.refetch()}
              >
                {t.runMonitor.retry}
              </Button>
            </div>
          ) : pendingCount === 0 ? (
            <p className="text-muted-foreground p-1 text-xs">
              {t.runMonitor.pendingEmpty}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {pauses.map((pause) => (
                <div
                  key={pause.id}
                  className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
                  data-testid="workflow-monitor-pause"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-mono">{pause.nodeId}</span>
                    <span className="text-muted-foreground">
                      {pause.kind === "step"
                        ? t.runMonitor.stepPause
                        : t.runMonitor.task}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => void handlePause(pause, "continue")}
                    >
                      {t.runMonitor.continue}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => void handlePause(pause, "skip")}
                    >
                      {t.runMonitor.skip}
                    </Button>
                  </div>
                </div>
              ))}
              {tasks.map((task) => (
                <WorkflowHumanTaskForm
                  key={task.id}
                  task={task}
                  onResolved={refresh}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}
