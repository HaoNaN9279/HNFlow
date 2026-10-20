"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

import { useWorkflowEditor, useWorkflowRun } from "./workflow-editor-context";
import { WorkflowErrorList } from "./workflow-error-list";

/**
 * Save toolbar for the workflow editor. Serializes the canvas back to a
 * definition (positions included) and PUTs it; a 422 surfaces the parsed
 * validation errors in the error strip (and highlights the offending canvas
 * nodes), any other failure is toasted.
 *
 * The Run/Stop control lives here too: Run is green and gated on a clean
 * document (dirty disables it with a tooltip), while a live run swaps it for a
 * destructive Stop. Saving is disabled during a run so the persisted
 * definition cannot drift from the instance being executed.
 */
export function WorkflowToolbar() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
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
  } = useWorkflowEditor();
  const { isRunning, startRun, cancelRun } = useWorkflowRun();
  const runLabels = t.workflows.run;

  const saveMutation = useMutation({
    mutationFn: (payload: UpdateWorkflowPayload) =>
      updateWorkflow(workflowId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      void queryClient.invalidateQueries({
        queryKey: ["workflows", workflowId],
      });
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
    const { definition: nextDefinition, metadata } = flowToDefinition(
      { nodes, edges },
      { def: definition, positions },
    );
    await saveMutation.mutateAsync({ definition: nextDefinition, metadata });
  }, [definition, edges, nodes, positions, saveMutation]);

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
    setWorkflowLocation({ kind: "directory" });
    router.push("/workspace/workflows");
  }, [router]);

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
          href="/workspace/workflows"
          data-testid="workflow-directory-link"
          data-dirty={dirty && !readonly ? "true" : undefined}
          title={dirty && !readonly ? t.workflows.unsaved : undefined}
          onClick={handleDirectoryClick}
        >
          <ArrowLeftIcon className="size-4" />
          {t.workflows.backToDirectory}
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
      {isRunning ? (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void cancelRun()}
        >
          {runLabels.stop}
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            onClick={() => void startRun()}
            disabled={readonly || dirty}
            title={dirty ? runLabels.runDisabled : undefined}
          >
            {runLabels.run}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void startRun({ debugStep: true })}
            disabled={readonly || dirty}
            title={dirty ? runLabels.runDisabled : runLabels.stepHint}
            data-testid="workflow-step-run"
          >
            {runLabels.step}
          </Button>
        </>
      )}
      <Button
        size="sm"
        onClick={handleSave}
        disabled={readonly || !dirty || saveMutation.isPending || isRunning}
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
