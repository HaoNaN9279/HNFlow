import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listWorkspaceResourceChanges,
  undoWorkspaceResourceChanges,
  type WorkspaceResourceChangeList,
  type WorkspaceUndoResult,
} from "./api";

export function workspaceResourceChangesQueryKey(threadId: string) {
  return ["workspace-resource-changes", threadId] as const;
}

export function useWorkspaceResourceChanges(
  threadId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery<WorkspaceResourceChangeList>({
    queryKey: workspaceResourceChangesQueryKey(threadId),
    queryFn: () => listWorkspaceResourceChanges(threadId),
    enabled: enabled && Boolean(threadId),
    staleTime: 5_000,
  });
}

export function useUndoWorkspaceResourceChanges(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    WorkspaceUndoResult,
    Error,
    { change_id?: string; dry_run?: boolean } | undefined
  >({
    mutationFn: (payload) =>
      undoWorkspaceResourceChanges(threadId, payload ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceResourceChangesQueryKey(threadId),
      });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      void queryClient.invalidateQueries({ queryKey: ["workflow-folders"] });
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
    },
  });
}
