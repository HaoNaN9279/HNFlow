import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  closeProject,
  createProject,
  getProject,
  listProjects,
  openProject,
} from "./api";

const PROJECTS_KEY = ["projects"] as const;

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: listProjects,
  });
}

export function useProject(projectId: string | null | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, projectId],
    queryFn: () => getProject(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export function useOpenProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: openProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useCloseProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: closeProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}
