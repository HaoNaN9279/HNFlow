import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";

rs.mock("@/core/agents/api", () => ({
  listAgents: rs.fn(),
}));

rs.mock("@/core/skills/api", () => ({
  loadSkills: rs.fn(),
}));

rs.mock("@/core/workflows/api", () => ({
  listWorkflows: rs.fn(),
}));

import { listAgents } from "@/core/agents/api";
import { loadSkills } from "@/core/skills/api";
import { listWorkflows } from "@/core/workflows/api";
import {
  useAgentOptions,
  useSkillOptions,
  useWorkflowTemplateOptions,
} from "@/core/workflows/canvas/use-node-form-options";
import { type WorkflowRecord } from "@/core/workflows/types";

const mockedListAgents = rs.mocked(listAgents);
const mockedLoadSkills = rs.mocked(loadSkills);
const mockedListWorkflows = rs.mocked(listWorkflows);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function QueryWrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function agentRecord(name: string) {
  return {
    name,
    description: `Agent ${name}`,
    model: null,
    tool_groups: [],
    skills: [],
  };
}

function skillRecord(name: string) {
  return {
    name,
    description: `Skill ${name}`,
    category: "general",
    license: "MIT",
    enabled: true,
    editable: true,
  };
}

function workflowRecord(
  id: string,
  name: string,
  version = "0.1.0",
): WorkflowRecord {
  return {
    id,
    user_id: "u-1",
    name,
    schema_version: 1,
    definition: {
      id,
      name,
      version,
      nodes: [],
      edges: [],
      metadata: {},
    },
    metadata: {},
    version,
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("useAgentOptions", () => {
  beforeEach(() => {
    mockedListAgents.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("maps agents to { name } entries", async () => {
    mockedListAgents.mockResolvedValue([
      agentRecord("lead"),
      agentRecord("researcher"),
    ]);

    const { result } = renderHook(() => useAgentOptions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { name: "lead" },
        { name: "researcher" },
      ]);
    });
  });

  it("degrades to an empty array when loading fails", async () => {
    mockedListAgents.mockRejectedValue(new Error("agents down"));

    const { result } = renderHook(() => useAgentOptions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useSkillOptions", () => {
  beforeEach(() => {
    mockedLoadSkills.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("unwraps the skills payload into skill names", async () => {
    mockedLoadSkills.mockResolvedValue([
      skillRecord("web-research"),
      skillRecord("code-review"),
    ]);

    const { result } = renderHook(() => useSkillOptions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([
        "web-research",
        "code-review",
      ]);
    });
  });

  it("degrades to an empty array when loading fails", async () => {
    mockedLoadSkills.mockRejectedValue(new Error("skills down"));

    const { result } = renderHook(() => useSkillOptions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useWorkflowTemplateOptions", () => {
  beforeEach(() => {
    mockedListWorkflows.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("maps workflows to template options and excludes excludeId", async () => {
    mockedListWorkflows.mockResolvedValue([
      workflowRecord("wf-1", "Alpha"),
      workflowRecord("wf-2", "Beta", "0.2.0"),
    ]);

    const { result } = renderHook(() => useWorkflowTemplateOptions("wf-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: "wf-2", name: "Beta", version: "0.2.0" },
      ]);
    });
  });

  it("keeps every workflow when excludeId is null", async () => {
    mockedListWorkflows.mockResolvedValue([
      workflowRecord("wf-1", "Alpha"),
      workflowRecord("wf-2", "Beta"),
    ]);

    const { result } = renderHook(() => useWorkflowTemplateOptions(null), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: "wf-1", name: "Alpha", version: "0.1.0" },
        { id: "wf-2", name: "Beta", version: "0.1.0" },
      ]);
    });
  });

  it("degrades to an empty array when loading fails", async () => {
    mockedListWorkflows.mockRejectedValue(new Error("workflows down"));

    const { result } = renderHook(() => useWorkflowTemplateOptions("wf-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(result.current.error).toBeNull();
  });

  it("keeps a stable query key so excludeId changes do not refetch", async () => {
    mockedListWorkflows.mockResolvedValue([
      workflowRecord("wf-1", "Alpha"),
      workflowRecord("wf-2", "Beta"),
      workflowRecord("wf-3", "Gamma"),
    ]);

    const { result, rerender } = renderHook(
      ({ excludeId }: { excludeId: string | null }) =>
        useWorkflowTemplateOptions(excludeId),
      {
        initialProps: { excludeId: "wf-1" },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: "wf-2", name: "Beta", version: "0.1.0" },
        { id: "wf-3", name: "Gamma", version: "0.1.0" },
      ]);
    });

    rerender({ excludeId: "wf-2" });

    expect(mockedListWorkflows).toHaveBeenCalledTimes(1);
  });
});
