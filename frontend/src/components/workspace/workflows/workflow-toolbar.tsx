"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
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
import {
  updateWorkflow,
  type UpdateWorkflowPayload,
} from "@/core/workflows/api";
import { flowToDefinition } from "@/core/workflows/canvas/mapping";
import { setWorkflowLocation } from "@/core/workflows/editor-session";
import { WorkflowValidationErrors } from "@/core/workflows/errors";

import { useWorkflowEditor } from "./workflow-editor-context";
import { WorkflowErrorList } from "./workflow-error-list";

/**
 * Save toolbar for the workflow editor. Serializes the canvas back to a
 * definition (positions included) and PUTs it; a 422 surfaces the parsed
 * validation errors in the error strip (and highlights the offending canvas
 * nodes), any other failure is toasted.
 *
 * Execution controls deliberately do not live here: every manual run is
 * launched from a workbench. Saving stays available while a run is active —
 * the run keeps its admission snapshot, so editing only affects later runs.
 */
export function WorkflowToolbar() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const workbenchId = searchParams.get("workbench");
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const {
    workflowId,
    definition,
    nodes,
    edges,
    positions,
    errors,
    setErrors,
    dirty,
    markSaved,
    discardDraft,
    readonly,
    embedded,
    saveEmbedded,
    currentDefinition,
  } = useWorkflowEditor();
  const projectId = searchParams.get("project");
  const backHref = workbenchId
    ? projectId
      ? `/workspace/projects/${encodeURIComponent(projectId)}/workbenches/${encodeURIComponent(workbenchId)}`
      : "/workspace/projects"
    : "/workspace/workflows";
  const backLabel = workbenchId
    ? t.workbenches.back
    : t.workflows.backToDirectory;

  const saveMutation = useMutation({
    mutationFn: (payload: UpdateWorkflowPayload) =>
      updateWorkflow(workflowId, {
        ...payload,
        project_id: projectId ?? undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      void queryClient.invalidateQueries({
        queryKey: ["workflows", workflowId],
      });
      void queryClient.invalidateQueries({ queryKey: ["capability-groups"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(t.workflows.errors.saveSuccess);
      setErrors([]);
      markSaved();
    },
    onError: (error: Error) => {
      if (error instanceof WorkflowValidationErrors) {
        setErrors(error.errors);
        toast.error(
          `${t.workflows.errors.validationPrefix}${error.errors
            .map((entry) => entry.message)
            .join("\n")}`,
        );
        return;
      }
      toast.error(`${t.workflows.errors.saveFailed}: ${error.message}`);
    },
  });

  const saveAsync = useCallback(async () => {
    if (embedded) {
      await saveEmbedded(currentDefinition());
      setErrors([]);
      markSaved();
      toast.success(t.workflows.properties.subworkflow.savedToParent);
      return;
    }
    const { definition: nextDefinition, metadata } = flowToDefinition(
      { nodes, edges },
      { def: definition, positions },
    );
    await saveMutation.mutateAsync({ definition: nextDefinition, metadata });
  }, [
    currentDefinition,
    definition,
    edges,
    embedded,
    markSaved,
    nodes,
    positions,
    saveEmbedded,
    saveMutation,
    setErrors,
    t.workflows.properties.subworkflow.savedToParent,
  ]);

  const handleSave = useCallback(() => {
    void saveAsync().catch(() => {
      // The mutation's onError already surfaced the reason.
    });
  }, [saveAsync]);

  const handleDirectoryClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!dirty || readonly) {
        return;
      }
      event.preventDefault();
      setLeaveDialogOpen(true);
    },
    [dirty, readonly],
  );

  const goToDirectory = useCallback(() => {
    if (!workbenchId) {
      setWorkflowLocation({ kind: "directory" });
    }
    router.push(backHref);
  }, [backHref, router, workbenchId]);

  const handleLeaveWithoutSaving = useCallback(() => {
    discardDraft();
    setLeaveDialogOpen(false);
    goToDirectory();
  }, [discardDraft, goToDirectory]);

  const handleLeaveAfterSave = useCallback(async () => {
    try {
      await saveAsync();
      setLeaveDialogOpen(false);
      goToDirectory();
    } catch {
      // Keep the dialog open so the user can retry or discard.
    }
  }, [goToDirectory, saveAsync]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <Button asChild size="sm" variant="ghost" className="-ml-2">
        <Link
          href={backHref}
          data-testid="workflow-directory-link"
          data-dirty={dirty && !readonly ? "true" : undefined}
          title={dirty && !readonly ? t.workflows.unsaved : undefined}
          onClick={handleDirectoryClick}
        >
          <ArrowLeftIcon className="size-4" />
          {backLabel}
          {dirty && !readonly && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
              data-testid="workflow-dirty-dot"
              aria-hidden="true"
            />
          )}
        </Link>
      </Button>
      {errors.length > 0 && <WorkflowErrorList errors={errors} />}
      <div className="flex-1" />
      {dirty && !readonly && (
        <span className="text-muted-foreground text-xs">
          {t.workflows.unsaved}
        </span>
      )}
      {readonly && <Badge variant="outline">{t.workflows.readonly}</Badge>}
      <Button
        size="sm"
        onClick={handleSave}
        disabled={readonly || !dirty || saveMutation.isPending}
      >
        {saveMutation.isPending ? t.workflows.saving : t.workflows.save}
      </Button>

      <Dialog open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
        <DialogContent data-testid="workflow-leave-dialog">
          <DialogHeader>
            <DialogTitle>{t.workflows.leave.title}</DialogTitle>
            <DialogDescription>
              {t.workflows.leave.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLeaveDialogOpen(false)}
            >
              {t.common.cancel}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saveMutation.isPending}
              onClick={handleLeaveWithoutSaving}
              data-testid="workflow-leave-discard"
            >
              {t.workflows.leave.discard}
            </Button>
            <Button
              type="button"
              disabled={saveMutation.isPending}
              onClick={() => void handleLeaveAfterSave()}
              data-testid="workflow-leave-save"
            >
              {saveMutation.isPending
                ? t.workflows.saving
                : t.workflows.leave.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
