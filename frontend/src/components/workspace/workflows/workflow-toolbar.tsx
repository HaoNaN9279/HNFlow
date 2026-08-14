"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import { updateWorkflow, type UpdateWorkflowPayload } from "@/core/workflows/api";
import { flowToDefinition } from "@/core/workflows/canvas/mapping";
import { WorkflowValidationErrors } from "@/core/workflows/errors";

import { useWorkflowEditor } from "./workflow-editor-context";
import { WorkflowErrorList } from "./workflow-error-list";

/**
 * Save toolbar for the workflow editor. Serializes the canvas back to a
 * definition (positions included) and PUTs it; a 422 surfaces the parsed
 * validation errors in the error strip (and highlights the offending canvas
 * nodes), any other failure is toasted.
 */
export function WorkflowToolbar() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
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
    readonly,
  } = useWorkflowEditor();

  const saveMutation = useMutation({
    mutationFn: (payload: UpdateWorkflowPayload) =>
      updateWorkflow(workflowId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows", workflowId] });
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

  const handleSave = useCallback(() => {
    const { definition: nextDefinition, metadata } = flowToDefinition(
      { nodes, edges },
      { def: definition, positions },
    );
    saveMutation.mutate({ definition: nextDefinition, metadata });
  }, [definition, edges, nodes, positions, saveMutation]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
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
    </div>
  );
}
