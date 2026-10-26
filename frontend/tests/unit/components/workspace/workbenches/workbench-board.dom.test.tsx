import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkbenchBoard } from "@/components/workspace/workbenches/workbench-board";

const mutations = rs.hoisted(() => ({
  run: rs.fn(),
  add: rs.fn(),
  remove: rs.fn(),
}));

rs.mock("@/core/workflows/workbench-hooks", () => ({
  useWorkbench: () => ({
    data: {
      id: "wb-1",
      name: "Project A",
      description: "Test project",
      revision: 1,
      layout: {},
      settings: {},
      members: [
        {
          id: "m-1",
          workbench_id: "wb-1",
          definition_id: "wf-1",
          order_index: 0,
          settings: {},
          created_at: "2026-01-01T00:00:00Z",
          definition_name: "Test workflow",
          definition_exists: true,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useWorkflows: () => ({ data: [], isLoading: false, isError: false }),
  useWorkbenchRuns: () => ({
    runs: [
      {
        run_id: "run-1",
        thread_id: "t-1",
        definition_id: "wf-1",
        definition_name: "Test workflow",
        workbench_id: "wb-1",
        workbench_name: "Project A",
        project_id: "proj-1",
        status: "running",
        display_state: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        elapsed_seconds: 12,
        current_node: "node-1",
        completed_nodes: 1,
        total_nodes: 2,
        pending_human_task_count: 0,
        pending_human_task_kinds: [],
        error_excerpt: null,
        workbench_attached: true,
      },
    ],
    isError: false,
  }),
  useAddWorkbenchMember: () => ({ mutate: mutations.add, isPending: false }),
  useRemoveWorkbenchMember: () => ({
    mutate: mutations.remove,
    isPending: false,
  }),
  useCreateWorkbenchRun: () => ({ mutate: mutations.run, isPending: false }),
  latestRunForDefinition: (runs: { definition_id: string }[], id: string) =>
    runs.find((run) => run.definition_id === id) ?? null,
  workbenchEditorHref: () =>
    "/workspace/workflows/wf-1?workbench=wb-1&project=proj-1",
}));

rs.mock("@/core/workflows/hooks", () => ({
  useWorkflows: () => ({ data: [], isLoading: false, isError: false }),
}));

rs.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

rs.mock("@/core/workflows/runs", () => ({
  cancelWorkflowRun: rs.fn(),
}));

rs.mock("sonner", () => ({
  toast: { success: rs.fn(), error: rs.fn() },
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      common: { loading: "Loading", cancel: "Cancel", delete: "Delete" },
      workbenches: {
        back: "Workbenches",
        addMember: "Add workflow",
        addMemberTitle: "Add workflow",
        addMemberHint: "Add a workflow",
        noAvailableWorkflows: "Nothing available",
        removeMember: "Remove",
        removeConfirm: (name: string) => `Remove ${name}?`,
        noMembers: "No workflows",
        noMembersHint: "Add one",
        run: "Run",
        step: "Step run",
        cancel: "Cancel",
        edit: "Edit",
        elapsed: "Elapsed",
        noActiveRun: "No active run",
        pendingHuman: "Waiting for human",
        cancelFailed: "Cancel failed",
        loadFailed: "Load failed",
      },
      runMonitor: {
        waitingHuman: "Waiting for human",
        currentNode: "Node",
        completed: "Done",
        loadFailed: "Load failed",
      },
      workflows: {
        run: {
          runStatus: {
            pending: "Pending",
            running: "Running",
            success: "Success",
            error: "Error",
            timeout: "Timeout",
            interrupted: "Interrupted",
          },
        },
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  mutations.run.mockReset();
  mutations.add.mockReset();
  mutations.remove.mockReset();
});

describe("WorkbenchBoard", () => {
  it("renders members with their latest run state", () => {
    render(<WorkbenchBoard projectId="proj-1" workbenchId="wb-1" />);
    expect(screen.getByText("Test workflow")).toBeTruthy();
    expect(screen.getByTestId("workbench-card-status").textContent).toBe(
      "Running",
    );
    expect(screen.getByText("run-1")).toBeTruthy();
  });

  it("starts a normal and a single-step run from the card", () => {
    render(<WorkbenchBoard projectId="proj-1" workbenchId="wb-1" />);
    fireEvent.click(screen.getByTestId("workbench-run"));
    expect(mutations.run).toHaveBeenCalledWith({ definition_id: "wf-1" });
    fireEvent.click(screen.getByTestId("workbench-step-run"));
    expect(mutations.run).toHaveBeenCalledWith({
      definition_id: "wf-1",
      debug_step: true,
    });
  });
});
