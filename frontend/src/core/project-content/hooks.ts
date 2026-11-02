import { useQuery } from "@tanstack/react-query";

import { loadProjectContent } from "./api";

export function useProjectContent(projectId?: string | null) {
  return useQuery({
    queryKey: ["project-content", projectId ?? "none"],
    queryFn: () => loadProjectContent(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}
