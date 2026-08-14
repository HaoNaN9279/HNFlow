import { useQuery } from "@tanstack/react-query";

import { listAgents } from "@/core/agents/api";
import { loadSkills } from "@/core/skills/api";

import { listWorkflows } from "../api";

export type WorkflowTemplateOption = {
  id: string;
  name: string;
  version: string;
};

const OPTIONS_STALE_TIME_MS = 60_000;

export function useAgentOptions() {
  return useQuery({
    queryKey: ["agentOptions"],
    queryFn: async (): Promise<{ name: string }[]> => {
      try {
        const agents = await listAgents();
        return agents.map((agent) => ({ name: agent.name }));
      } catch {
        return [];
      }
    },
    staleTime: OPTIONS_STALE_TIME_MS,
  });
}

export function useSkillOptions() {
  return useQuery({
    queryKey: ["skillOptions"],
    queryFn: async (): Promise<string[]> => {
      try {
        const skills = await loadSkills();
        return skills.map((skill) => skill.name);
      } catch {
        return [];
      }
    },
    staleTime: OPTIONS_STALE_TIME_MS,
  });
}

export function useWorkflowTemplateOptions(excludeId: string | null) {
  return useQuery({
    queryKey: ["workflowTemplateOptions"],
    queryFn: async (): Promise<WorkflowTemplateOption[]> => {
      try {
        const workflows = await listWorkflows();
        return workflows
          .filter((workflow) => workflow.id !== excludeId)
          .map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            version: workflow.version,
          }));
      } catch {
        return [];
      }
    },
    staleTime: OPTIONS_STALE_TIME_MS,
  });
}
