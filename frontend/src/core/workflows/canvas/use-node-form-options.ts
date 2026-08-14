import { useQuery } from "@tanstack/react-query";

import { listAgents } from "@/core/agents/api";
import { loadSkills } from "@/core/skills/api";

import { listWorkflows } from "../api";
import {
  type NodeType,
  type PortType,
  type WorkflowDefinition,
} from "../types";

export type WorkflowTemplatePort = { name: string; type: PortType };

export type WorkflowTemplateOption = {
  id: string;
  name: string;
  version: string;
  startOutputPorts: WorkflowTemplatePort[];
  endOutputPorts: WorkflowTemplatePort[];
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
            startOutputPorts: outputPortsOf(workflow.definition, "flow:start"),
            endOutputPorts: outputPortsOf(workflow.definition, "flow:end"),
          }));
      } catch {
        return [];
      }
    },
    staleTime: OPTIONS_STALE_TIME_MS,
  });
}

function outputPortsOf(
  definition: WorkflowDefinition,
  nodeType: NodeType,
): WorkflowTemplatePort[] {
  const node = definition.nodes.find((node) => node.type === nodeType);
  if (!node) {
    return [];
  }
  return node.outputs.map(({ name, type }) => ({ name, type }));
}
