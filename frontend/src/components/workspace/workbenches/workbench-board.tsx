"use client";

import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/core/i18n/hooks";
import { useWorkflows } from "@/core/workflows/hooks";
import { cancelWorkflowRun } from "@/core/workflows/runs";
import {
  latestRunForDefinition,
  useAddWorkbenchMember,
  useCreateWorkbenchRun,
  useRemoveWorkbenchMember,
  useWorkbench,
  useWorkbenchRuns,
  workbenchEditorHref,
} from "@/core/workflows/workbench-hooks";
import type { WorkbenchMember } from "@/core/workflows/workbenches";
import { cn } from "@/lib/utils";

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

function memberName(member: WorkbenchMember): string {
  return member.definition_name ?? member.definition_id;
}

export function WorkbenchBoard({ workbenchId }: { workbenchId: string }) {
  const { t } = useI18n();
  const params = useSearchParams();
  const selectedRunId = params.get("run");
  const workbench = useWorkbench(workbenchId);
  const workflows = useWorkflows();
  const { runs, isError: runsError } = useWorkbenchRuns(workbenchId);
  const addMember = useAddWorkbenchMember(workbenchId);
  const removeMember = useRemoveWorkbenchMember(workbenchId);
  const createRun = useCreateWorkbenchRun(workbenchId);

  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<WorkbenchMember | null>(
    null,
  );
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);

  const members = useMemo(
    () => workbench.data?.members ?? [],
    [workbench.data?.members],
  );
  const memberIds = useMemo(
    () => new Set(members.map((member) => member.definition_id)),
    [members],
  );
  const availableWorkflows = (workflows.data ?? []).filter(
    (workflow) => !memberIds.has(workflow.id),
  );

  const handleCancel = async (definitionId: string, runId: string) => {
    setCancelBusy(runId);
    try {
      await cancelWorkflowRun(definitionId, runId);
      toast.success(t.workbenches.cancel);
    } catch (error) {
      toast.error(
        `${t.workbenches.cancelFailed}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setCancelBusy(null);
    }
  };

  return (
    <div className="flex size-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-4">
        <Button asChild size="sm" variant="ghost" className="-ml-2">
          <Link href="/workspace/workbenches">
            <ArrowLeftIcon className="size-4" />
            {t.workbenches.back}
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">
            {workbench.data?.name ?? t.common.loading}
          </h1>
          {workbench.data?.description && (
            <p className="text-muted-foreground truncate text-xs">
              {workbench.data.description}
            </p>
          )}
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <PlusIcon className="mr-1.5 size-4" />
          {t.workbenches.addMember}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {workbench.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : workbench.isError ? (
          <div className="text-destructive text-sm">
            {t.workbenches.loadFailed}: {workbench.error.message}
          </div>
        ) : members.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="font-medium">{t.workbenches.noMembers}</p>
            <p className="text-muted-foreground text-sm">
              {t.workbenches.noMembersHint}
            </p>
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <PlusIcon className="mr-1.5 size-4" />
              {t.workbenches.addMember}
            </Button>
          </div>
        ) : (
          <div
            className="grid w-full gap-3 md:grid-cols-2 2xl:grid-cols-3"
            data-testid="workbench-board"
          >
            {members.map((member) => {
              const latest = latestRunForDefinition(runs, member.definition_id);
              const active =
                latest != null &&
                (latest.status === "pending" ||
                  latest.status === "running" ||
                  latest.display_state === "waiting_human");
              const displayState = latest?.display_state ?? "pending";
              const isSelected = latest?.run_id === selectedRunId;
              return (
                <div
                  key={member.id}
                  className={cn(
                    "flex flex-col gap-3 rounded-lg border p-4",
                    isSelected && "ring-ring ring-2",
                  )}
                  data-testid={`workbench-card-${member.definition_id}`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {memberName(member)}
                      </p>
                      <p className="text-muted-foreground truncate font-mono text-[10px]">
                        {member.definition_id}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0",
                        STATUS_CLASSES[displayState] ??
                          STATUS_CLASSES.interrupted,
                      )}
                      data-testid="workbench-card-status"
                      data-status={displayState}
                    >
                      {displayState === "waiting_human"
                        ? t.runMonitor.waitingHuman
                        : latest
                          ? (t.workflows.run.runStatus[
                              latest.status as keyof typeof t.workflows.run.runStatus
                            ] ?? latest.status)
                          : t.workbenches.noActiveRun}
                    </Badge>
                  </div>

                  <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                    {latest ? (
                      <>
                        <span className="truncate font-mono">
                          {latest.run_id}
                        </span>
                        <span>
                          {t.workbenches.elapsed}:{" "}
                          {formatElapsed(latest.elapsed_seconds)}
                          {latest.current_node
                            ? ` · ${t.runMonitor.currentNode}: ${latest.current_node}`
                            : ""}
                        </span>
                        {latest.completed_nodes != null &&
                          latest.total_nodes != null && (
                            <span>
                              {t.runMonitor.completed}: {latest.completed_nodes}
                              /{latest.total_nodes}
                            </span>
                          )}
                        {latest.pending_human_task_count > 0 && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {t.workbenches.pendingHuman}:{" "}
                            {latest.pending_human_task_count}
                          </span>
                        )}
                        {latest.error_excerpt && (
                          <span className="text-destructive line-clamp-2">
                            {latest.error_excerpt}
                          </span>
                        )}
                      </>
                    ) : (
                      <span>{t.workbenches.noActiveRun}</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      className="bg-emerald-600 text-white hover:bg-emerald-600/90"
                      disabled={createRun.isPending}
                      onClick={() =>
                        createRun.mutate({
                          definition_id: member.definition_id,
                        })
                      }
                      data-testid="workbench-run"
                    >
                      {t.workbenches.run}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={createRun.isPending}
                      onClick={() =>
                        createRun.mutate({
                          definition_id: member.definition_id,
                          debug_step: true,
                        })
                      }
                      data-testid="workbench-step-run"
                    >
                      {t.workbenches.step}
                    </Button>
                    {latest && active && (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={cancelBusy === latest.run_id}
                        onClick={() =>
                          void handleCancel(member.definition_id, latest.run_id)
                        }
                      >
                        {t.workbenches.cancel}
                      </Button>
                    )}
                    <Button asChild size="sm" variant="ghost">
                      <Link
                        href={workbenchEditorHref(
                          workbenchId,
                          member.definition_id,
                        )}
                      >
                        {t.workbenches.edit}
                      </Link>
                    </Button>
                    <div className="flex-1" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      title={t.workbenches.removeMember}
                      aria-label={t.workbenches.removeMember}
                      onClick={() => setRemoveTarget(member)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {runsError && (
          <p className="text-muted-foreground mt-4 text-xs">
            {t.runMonitor.loadFailed}
          </p>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workbenches.addMemberTitle}</DialogTitle>
            <DialogDescription>{t.workbenches.addMemberHint}</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {availableWorkflows.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t.workbenches.noAvailableWorkflows}
              </p>
            ) : (
              availableWorkflows.map((workflow) => (
                <Button
                  key={workflow.id}
                  type="button"
                  variant="ghost"
                  className="justify-start"
                  disabled={addMember.isPending}
                  onClick={() =>
                    addMember.mutate(workflow.id, {
                      onSuccess: () => setAddOpen(false),
                    })
                  }
                >
                  <span className="truncate">{workflow.name}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                    {workflow.id}
                  </span>
                </Button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t.common.cancel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workbenches.removeMember}</DialogTitle>
            <DialogDescription>
              {removeTarget
                ? t.workbenches.removeConfirm(memberName(removeTarget))
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={removeMember.isPending}
              onClick={() => {
                if (!removeTarget) return;
                removeMember.mutate(removeTarget.definition_id, {
                  onSuccess: () => setRemoveTarget(null),
                });
              }}
            >
              {removeMember.isPending ? t.common.loading : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
