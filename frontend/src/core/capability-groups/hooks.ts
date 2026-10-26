import { useQuery } from "@tanstack/react-query";

import {
  loadCapabilityGroup,
  loadCapabilityGroups,
  revealCapabilityGroup,
  revealCapabilityGroupFile,
} from "./api";

export function useCapabilityGroups(projectId?: string) {
  return useQuery({
    queryKey: ["capability-groups", projectId ?? "global"],
    queryFn: () => loadCapabilityGroups(projectId),
  });
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
