"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/i18n/hooks";
import {
  useCreateWorkflow,
  useDeleteWorkflow,
  useWorkflowRuns,
  useWorkflows,
} from "@/core/workflows/hooks";
import type { WorkflowRunStatus } from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

/**
 * The backend creates a blank definition server-side (id/name are re-stamped
 * at persistence time), but the create payload requires a structurally valid
 * `definition` — send an empty one.
 */
function blankDefinition(name: string): WorkflowRecord["definition"] {
  return { id: "draft", name, version: "0.1.0", nodes: [], edges: [], metadata: {} };
}

function formatTimestamp(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const intlLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(intlLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Tailwind classes per run status for the list-row badge. */
const RUN_STATUS_BADGE_CLASSES: Record<WorkflowRunStatus, string> = {
  pending: "border-transparent bg-muted text-muted-foreground",
  running: "border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400",
  success:
    "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  error: "border-transparent bg-destructive/10 text-destructive",
  timeout:
    "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  interrupted: "border-transparent bg-muted text-muted-foreground",
};

/**
 * Latest-run status badge for one workflow row.
 *
 * Run history is monitor metadata: while it loads, when the workflow has no
 * runs, or when the backend cannot serve it (e.g. 503 without the SQL memory
 * backend) the badge renders nothing so a monitoring outage never disturbs
 * the list page.
 */
function LatestRunBadge({ workflowId }: { workflowId: string }) {
  const { t } = useI18n();
  const runs = useWorkflowRuns(workflowId, { limit: 1 });
  if (runs.isLoading || runs.isError) {
    return null;
  }
  const latest = runs.data?.runs[0];
  if (!latest) {
    return null;
  }
  return (
    <Badge
      variant="outline"
      className={RUN_STATUS_BADGE_CLASSES[latest.status]}
      data-testid="workflow-run-badge"
      data-status={latest.status}
    >
      {t.workflows.run.runStatus[latest.status]}
    </Badge>
  );
}

export function WorkflowList() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const workflows = useWorkflows();
  const createWorkflow = useCreateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WorkflowRecord | null>(null);

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    createWorkflow.mutate(
      { name: trimmed, definition: blankDefinition(trimmed) },
      {
        onSuccess: (record) => {
          setCreateOpen(false);
          setName("");
          router.push(`/workspace/workflows/${encodeURIComponent(record.id)}`);
        },
      },
    );
  };

  return (
    <div className="flex size-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-xl font-semibold">{t.workflows.title}</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon className="mr-1.5 h-4 w-4" />
          {t.workflows.create}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {workflows.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : workflows.isError ? (
          <div className="text-destructive text-sm" data-testid="workflow-list-error">
            {t.workflows.errors.loadFailed}: {workflows.error.message}
          </div>
        ) : (workflows.data ?? []).length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="font-medium">{t.workflows.empty}</p>
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="mr-1.5 h-4 w-4" />
              {t.workflows.create}
            </Button>
          </div>
        ) : (
          <div
            className="mx-auto flex w-full max-w-(--container-width-lg) flex-col gap-2"
            data-testid="workflow-list"
          >
            {(workflows.data ?? []).map((workflow) => (
              <div
                key={workflow.id}
                className="hover:bg-accent/50 flex items-center gap-3 rounded-lg border p-4"
                data-testid={`workflow-row-${workflow.id}`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                  onClick={() =>
                    router.push(
                      `/workspace/workflows/${encodeURIComponent(workflow.id)}`,
                    )
                  }
                >
                  <span className="font-medium">{workflow.name}</span>
                  <span className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                    <span className="font-mono">{workflow.id}</span>
                    <span>
                      {t.common.version}: {workflow.version}
                    </span>
                    <span>
                      {t.common.lastUpdated}:{" "}
                      {formatTimestamp(workflow.updated_at, locale)}
                    </span>
                  </span>
                </button>
                <LatestRunBadge workflowId={workflow.id} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => setDeleteTarget(workflow)}
                  aria-label={`${t.common.delete} ${workflow.name}`}
                  title={t.common.delete}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.createTitle}</DialogTitle>
            <DialogDescription>
              {t.workflows.namePlaceholder}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t.workflows.namePlaceholder}
            aria-label={t.workflows.nameLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim()) {
                handleCreate();
              }
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={createWorkflow.isPending}
            >
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || createWorkflow.isPending}
            >
              {createWorkflow.isPending ? t.common.loading : t.workflows.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.title}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t.workflows.deleteConfirm(deleteTarget.name)
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteWorkflow.isPending}
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  deleteWorkflow.mutate(deleteTarget.id, {
                    onSuccess: () => setDeleteTarget(null),
                  });
                }
              }}
              disabled={deleteWorkflow.isPending}
            >
              {deleteWorkflow.isPending
                ? t.common.loading
                : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
