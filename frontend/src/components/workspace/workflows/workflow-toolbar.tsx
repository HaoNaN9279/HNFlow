"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import {
  fetchWorkflowTemplates,
  updateWorkflow,
  type UpdateWorkflowPayload,
  type WorkflowTemplate,
} from "@/core/workflows/api";
import { flowToDefinition } from "@/core/workflows/canvas/mapping";
import { insertTemplateFlow } from "@/core/workflows/canvas/templates";
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
  const {
    workflowId,
    definition,
    nodes,
    edges,
    positions,
    errors,
    setErrors,
    setNodes,
    setEdges,
    updatePositions,
    dirty,
    markDirty,
    markSaved,
    readonly,
  } = useWorkflowEditor();
  const { isRunning, startRun, cancelRun } = useWorkflowRun();
  const runLabels = t.workflows.run;
  const templateLabels = t.workflows.templates;
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Templates are fetched only once the picker is opened — a workflow editor
  // that never inserts one makes no request.
  const templatesQuery = useQuery({
    queryKey: ["workflowTemplates"],
    queryFn: fetchWorkflowTemplates,
    enabled: templatesOpen,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const handleInsertTemplate = useCallback(
    (template: WorkflowTemplate) => {
      try {
        const insertion = insertTemplateFlow(template.definition, {
          existingNodes: nodes,
        });
        setNodes((current) => [...current, ...insertion.nodes]);
        setEdges((current) => [...current, ...insertion.edges]);
        updatePositions({ ...positions, ...insertion.positions });
        markDirty();
        setTemplatesOpen(false);
      } catch (error) {
        toast.error(
          `${templateLabels.insertFailed}: ${(error as Error).message}`,
        );
      }
    },
    [
      markDirty,
      nodes,
      positions,
      setEdges,
      setNodes,
      templateLabels.insertFailed,
      updatePositions,
    ],
  );

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
      {templatesOpen && (
        <div
          className="bg-popover text-popover-foreground absolute z-10 mt-10 max-h-72 w-72 overflow-auto rounded-md border p-2 shadow-md"
          role="menu"
        >
          <p className="text-muted-foreground px-2 pb-1 text-xs">
            {templateLabels.hint}
          </p>
          {templatesQuery.isPending && (
            <p className="text-muted-foreground px-2 py-1 text-xs">
              {templateLabels.label}…
            </p>
          )}
          {templatesQuery.isError && (
            <p className="text-destructive px-2 py-1 text-xs">
              {templateLabels.loadFailed}
            </p>
          )}
          {templatesQuery.data?.length === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-xs">
              {templateLabels.empty}
            </p>
          )}
          {templatesQuery.data?.map((template) => (
            <Button
              key={template.name}
              className="flex h-auto w-full flex-col items-start gap-0.5 py-2"
              size="sm"
              variant="ghost"
              onClick={() => handleInsertTemplate(template)}
            >
              <span className="text-sm font-medium">{template.name}</span>
              <span className="text-muted-foreground text-left text-xs whitespace-normal">
                {template.description}
              </span>
            </Button>
          ))}
        </div>
      )}
      {!readonly && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTemplatesOpen((current) => !current)}
          title={templateLabels.hint}
        >
          {templateLabels.label}
        </Button>
      )}
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
        <Button
          size="sm"
          className="bg-emerald-600 text-white hover:bg-emerald-600/90"
          onClick={() => void startRun()}
          disabled={readonly || dirty}
          title={dirty ? runLabels.runDisabled : undefined}
        >
          {runLabels.run}
        </Button>
      )}
      <Button
        size="sm"
        onClick={handleSave}
        disabled={readonly || !dirty || saveMutation.isPending || isRunning}
      >
        {saveMutation.isPending ? t.workflows.saving : t.workflows.save}
      </Button>
    </div>
  );
}
