import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { WorkflowList } from "@/components/workspace/workflows/workflow-list";
import type { WorkflowRecord } from "@/core/workflows/types";

const apiMock = rs.hoisted(() => ({
  listWorkflows: rs.fn(),
  listWorkflowRuns: rs.fn(),
  createWorkflow: rs.fn(),
  getWorkflow: rs.fn(),
  updateWorkflow: rs.fn(),
  deleteWorkflow: rs.fn(),
}));
const toastMock = rs.hoisted(() => ({ success: rs.fn(), error: rs.fn() }));
const routerMock = rs.hoisted(() => ({ push: rs.fn() }));

rs.mock("@/core/workflows/api", () => apiMock);

rs.mock("sonner", () => ({
  toast: toastMock,
}));

// WorkflowList navigates via useRouter on create/delete; hand it a no-op
// router so those flows stay inert under happy-dom.
rs.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerMock.push }),
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    locale: "en-US",
    t: {
      common: {
        loading: "Loading...",
        version: "Version",
        lastUpdated: "Last updated",
        delete: "Delete",
        cancel: "Cancel",
      },
      workflows: {
        title: "Workflows",
        empty: "No workflows yet",
        create: "New workflow",
        createTitle: "Create workflow",
        nameLabel: "Name",
        namePlaceholder: "e.g. Data analysis pipeline",
        deleteConfirm: (name: string) => `Delete ${name}?`,
        errors: {
          loadFailed: "Failed to load workflows",
          saveSuccess: "Workflow saved",
          saveFailed: "Failed to save workflow",
          deleteFailed: "Failed to delete workflow",
          validationPrefix: "Validation failed: ",
        },
        run: {
          runStatus: {
            pending: "Pending",
            running: "Running",
            success: "Success",
            error: "Failed",
            timeout: "Timed out",
            interrupted: "Interrupted",
          },
        },
      },
    },
  }),
}));

afterEach(() => {
  apiMock.listWorkflows.mockReset();
  apiMock.listWorkflowRuns.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  routerMock.push.mockReset();
  cleanup();
});

function makeRecord(): WorkflowRecord {
  return {
    id: "wf-1",
    user_id: "u-1",
    name: "My workflow",
    schema_version: 1,
    definition: {
      id: "wf-1",
      name: "My workflow",
      version: "0.1.0",
      nodes: [],
      edges: [],
      metadata: {},
    },
    metadata: {},
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkflowList />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("WorkflowList", () => {
  it("renders the latest run status badge per workflow", async () => {
    apiMock.listWorkflows.mockResolvedValue([makeRecord()]);
    apiMock.listWorkflowRuns.mockResolvedValue({
      runs: [
        {
          run_id: "run-1",
          thread_id: "thread-1",
          status: "success",
          duration_seconds: 42,
        },
      ],
      hasMore: false,
    });

    renderList();

    expect(await screen.findByText("My workflow")).toBeTruthy();
    const badge = await screen.findByTestId("workflow-run-badge");
    expect(badge.textContent).toBe("Success");
    expect(badge.getAttribute("data-status")).toBe("success");
    expect(apiMock.listWorkflowRuns).toHaveBeenCalledWith("wf-1", {
      limit: 1,
    });
  });

  it("does not render a badge when the workflow has no runs", async () => {
    apiMock.listWorkflows.mockResolvedValue([makeRecord()]);
    apiMock.listWorkflowRuns.mockResolvedValue({ runs: [], hasMore: false });

    const queryClient = renderList();

    await screen.findByText("My workflow");
    await waitFor(() => {
      expect(
        queryClient.getQueryState(["workflow-runs", "wf-1"])?.status,
      ).toBe("success");
    });
    expect(screen.queryByTestId("workflow-run-badge")).toBeNull();
  });

  it("degrades silently when run history is unavailable (503)", async () => {
    apiMock.listWorkflows.mockResolvedValue([makeRecord()]);
    apiMock.listWorkflowRuns.mockRejectedValue(
      new Error("Run history requires a SQL database backend"),
    );

    const queryClient = renderList();

    await screen.findByText("My workflow");
    await waitFor(() => {
      expect(
        queryClient.getQueryState(["workflow-runs", "wf-1"])?.status,
      ).toBe("error");
    });
    // The row still renders, the badge stays hidden, and no toast fires.
    expect(screen.getByTestId("workflow-row-wf-1")).toBeTruthy();
    expect(screen.queryByTestId("workflow-run-badge")).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("renders the workflow list metadata (regression)", async () => {
    apiMock.listWorkflows.mockResolvedValue([makeRecord()]);
    apiMock.listWorkflowRuns.mockResolvedValue({ runs: [], hasMore: false });

    renderList();

    expect(await screen.findByText("My workflow")).toBeTruthy();
    expect(screen.getByText("wf-1")).toBeTruthy();
    expect(screen.getByText(/Version: 0\.1\.0/)).toBeTruthy();
  });
});
