import { useQuery } from "@tanstack/react-query";

import {
  loadCapabilityGroup,
  loadCapabilityGroups,
  revealCapabilityGroup,
  revealCapabilityGroupFile,
} from "./api";

export function useCapabilityGroupCatalog(projectId?: string) {
  return useQuery({
    queryKey: ["capability-groups", projectId ?? "global"],
    queryFn: () => loadCapabilityGroups(projectId),
  });
}

/** Array-shaped compatibility hook used by node editors. */
export function useCapabilityGroups(projectId?: string) {
  const query = useCapabilityGroupCatalog(projectId);
  return {
    ...query,
    data: query.data?.groups,
    repository: query.data?.repository,
    core: query.data?.core,
    warnings: query.data?.warnings ?? [],
  };
}

export function useCapabilityGroup(
  groupId: string,
  version: string | undefined,
  enabled: boolean,
  projectId?: string,
) {
  return useQuery({
    queryKey: [
      "capability-group",
      groupId,
      version ?? "current",
      projectId ?? "global",
    ],
    queryFn: () => loadCapabilityGroup(groupId, version, projectId),
    enabled,
  });
}

export { revealCapabilityGroup, revealCapabilityGroupFile };
