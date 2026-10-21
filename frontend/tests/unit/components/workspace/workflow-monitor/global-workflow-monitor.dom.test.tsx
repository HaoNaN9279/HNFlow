import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { GlobalWorkflowMonitor } from "@/components/workspace/workflow-monitor/global-workflow-monitor";

const monitorMock = rs.hoisted(() => ({
  runs: [
    {
      run_id: "run-1",
      thread_id: "t-1",
      definition_id: "wf-1",
      definition_name: "Test workflow",
      workbench_id: "wb-1",
      workbench_name: "Project A",
      status: "running",
      display_state: "running",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      elapsed_seconds: 65,
      current_node: "node-2",
      completed_nodes: 1,
      total_nodes: 3,
      pending_human_task_count: 1,
      pending_human_task_kinds: ["review"],
      error_excerpt: null,
      workbench_attached: true,
    },
  ],
}));

rs.mock("@/core/workflows/workbench-hooks", () => ({
  useMonitorRuns: () => ({
    data: monitorMock.runs,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: rs.fn(),
  }),
}));

rs.mock("@/core/workflows/human-tasks", () => ({
  fetchPendingHumanTasks: rs.fn().mockResolvedValue([]),
  pendingDebugPauses: () => [],
  pendingHumanTasks: () => [],
  continueDebugPause: rs.fn(),
  skipHumanTask: rs.fn(),
}));

rs.mock("next/navigation", () => ({
  useRouter: () => ({ push: rs.fn() }),
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      common: {},
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
      workbenches: { pendingHuman: "Waiting for human" },
      runMonitor: {
        title: "Execution monitor",
        collapse: "Collapse monitor",
        expand: "Expand monitor",
        resize: "Resize monitor",
        loading: "Loading runs...",
        empty: "No running workflows",
        loadFailed: "Failed to load running workflows",
        retry: "Retry",
        pendingTitle: "Needs attention",
        pendingEmpty: "No pending human tasks",
        pendingLoadFailed: "Failed to load human tasks",
        review: "Review",
        task: "Human task",
        stepPause: "Step pause",
        continue: "Continue",
        skip: "Skip",
        actionFailed: "Action failed",
        openWorkbench: "Open workbench",
        active: "Active",
        waitingHuman: "Waiting for human",
        unassigned: "Unassigned workbench",
        currentNode: "Node",
        completed: "Done",
        elapsed: "Elapsed",
      },
    },
  }),
}));

afterEach(() => cleanup());

function renderMonitor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GlobalWorkflowMonitor />
    </QueryClientProvider>,
  );
}

describe("GlobalWorkflowMonitor", () => {
  it("renders active runs and the pending human badge", () => {
    renderMonitor();
    expect(screen.getByTestId("global-workflow-monitor")).toBeTruthy();
    expect(screen.getByText("Test workflow")).toBeTruthy();
    expect(screen.getByText("Project A")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("collapses to a rail and expands again", () => {
    renderMonitor();
    fireEvent.click(screen.getByTestId("workflow-monitor-collapse"));
    expect(
      screen.getByTestId("global-workflow-monitor-collapsed"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("workflow-monitor-expand"));
    expect(screen.getByTestId("global-workflow-monitor")).toBeTruthy();
  });
});
