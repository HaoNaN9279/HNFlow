import { useQuery } from "@tanstack/react-query";

import {
  loadCapabilityGroup,
  loadCapabilityGroups,
  revealCapabilityGroupFile,
} from "./api";

export function useCapabilityGroups() {
  return useQuery({
    queryKey: ["capability-groups"],
    queryFn: loadCapabilityGroups,
  });
}

export function useCapabilityGroup(
  groupId: string,
  version: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["capability-group", groupId, version ?? "current"],
    queryFn: () => loadCapabilityGroup(groupId, version),
    enabled,
  });
}

export { revealCapabilityGroupFile };
