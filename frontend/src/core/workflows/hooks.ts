import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useI18n } from "@/core/i18n/hooks";

import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
  type CreateWorkflowPayload,
  type UpdateWorkflowPayload,
} from "./api";
import { WorkflowValidationErrors } from "./errors";

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: listWorkflows,
  });
}

export function useWorkflow(id: string | null | undefined) {
  return useQuery({
    queryKey: ["workflows", id],
    queryFn: () => getWorkflow(id ?? ""),
    enabled: Boolean(id),
  });
}

/**
 * Recent runs for one workflow from the console history endpoint.
 *
 * Run history is monitor metadata — when the backend cannot serve it (e.g.
 * 503 without the SQL memory backend) the failure must not disturb the list
 * page, so the query is non-retrying and callers render nothing on error.
 */
export function useWorkflowRuns(id: string, opts?: { limit?: number }) {
  return useQuery({
    queryKey: ["workflow-runs", id],
    queryFn: () => listWorkflowRuns(id, opts),
    enabled: Boolean(id),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (payload: CreateWorkflowPayload) => createWorkflow(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      toast.success(t.workflows.errors.saveSuccess);
    },
    onError: (error: Error) => {
      toast.error(`${t.workflows.errors.saveFailed}: ${error.message}`);
    },
  });
}

export function useUpdateWorkflow(id: string) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (payload: UpdateWorkflowPayload) => updateWorkflow(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows", id] });
      toast.success(t.workflows.errors.saveSuccess);
    },
    onError: (error: Error) => {
      if (error instanceof WorkflowValidationErrors) {
        toast.error(
          `${t.workflows.errors.validationPrefix}${error.errors.map((e) => e.message).join("\n")}`,
        );
        return;
      }
      toast.error(`${t.workflows.errors.saveFailed}: ${error.message}`);
    },
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      toast.success(t.workflows.errors.saveSuccess);
    },
    onError: (error: Error) => {
      toast.error(`${t.workflows.errors.deleteFailed}: ${error.message}`);
    },
  });
}
