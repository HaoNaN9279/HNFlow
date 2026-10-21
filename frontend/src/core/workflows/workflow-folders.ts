import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

export type WorkflowFolder = {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
};

function foldersUrl(path = ""): string {
  return `${getBackendBaseURL()}/api/workflow-folders${path}`;
}

async function throwFolderError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  throw new Error(typeof body.detail === "string" ? body.detail : fallback);
}

export async function listWorkflowFolders(): Promise<WorkflowFolder[]> {
  const response = await fetch(foldersUrl());
  if (!response.ok) {
    await throwFolderError(
      response,
      `Failed to load folders: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowFolder[]>;
}

export async function createWorkflowFolder(payload: {
  name: string;
  parent_id?: string | null;
}): Promise<WorkflowFolder> {
  const response = await fetch(foldersUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwFolderError(
      response,
      `Failed to create folder: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowFolder>;
}

export async function updateWorkflowFolder(
  id: string,
  payload: { name?: string; parent_id?: string | null },
): Promise<WorkflowFolder> {
  const response = await fetch(foldersUrl(`/${encodeURIComponent(id)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwFolderError(
      response,
      `Failed to update folder: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowFolder>;
}

export async function deleteWorkflowFolder(id: string): Promise<void> {
  const response = await fetch(foldersUrl(`/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!response.ok) {
    await throwFolderError(
      response,
      `Failed to delete folder: ${response.statusText}`,
    );
  }
}

export function useWorkflowFolders() {
  return useQuery({
    queryKey: ["workflow-folders"],
    queryFn: listWorkflowFolders,
  });
}

export function useCreateWorkflowFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createWorkflowFolder,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-folders"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateWorkflowFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: string;
      name?: string;
      parent_id?: string | null;
    }) => updateWorkflowFolder(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-folders"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteWorkflowFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteWorkflowFolder,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-folders"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
