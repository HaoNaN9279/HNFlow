import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowToolbar } from "@/components/workspace/workflows/workflow-toolbar";
import { WorkflowValidationErrors } from "@/core/workflows/errors";
import { streamWorkflowRun } from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

const apiMock = rs.hoisted(() => ({ updateWorkflow: rs.fn() }));
const toastMock = rs.hoisted(() => ({ success: rs.fn(), error: rs.fn() }));

rs.mock("@/core/workflows/api", () => ({
  updateWorkflow: apiMock.updateWorkflow,
}));

rs.mock("sonner", () => ({
  toast: toastMock,
}));

rs.mock("@/core/workflows/runs", () => ({
  streamWorkflowRun: rs.fn(),
  cancelWorkflowRun: rs.fn(),
}));

const mockedStream = rs.mocked(streamWorkflowRun);

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        unsaved: "Unsaved",
        readonly: "Read only",
        save: "Save",
        saving: "Saving...",
        run: {
          run: "Run",
          runDisabled: "Save unsaved changes first",
          stop: "Stop",
        },
        errors: {
          saveSuccess: "Workflow saved",
          saveFailed: "Failed to save workflow",
          validationPrefix: "Validation failed: ",
        },
      },
    },
  }),
}));

afterEach(() => {
  apiMock.updateWorkflow.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  mockedStream.mockReset();
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
      nodes: [
        {
          id: "n_1",
          type: "flow:start",
          inputs: [],
          outputs: [{ name: "out", type: "data", required: true }],
          params: {},
          capability_groups: [],
          agent_name: null,
        },
      ],
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

/** Drives the shared dirty flag from the test (the canvas would do this). */
function DirtyBridge() {
  const { markDirty } = useWorkflowEditor();
  return (
    <button type="button" onClick={markDirty}>
      mark-dirty
    </button>
  );
}

function renderToolbar(options: { readonly?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowEditorProvider record={makeRecord()} readonly={options.readonly}>
        <DirtyBridge />
        <WorkflowToolbar />
      </WorkflowEditorProvider>
    </QueryClientProvider>,
  );
}

describe("WorkflowToolbar", () => {
  it("enables save only after the editor is dirty", () => {
    renderToolbar();

    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Save" }) )
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));

    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Save" }) )
        .disabled,
    ).toBe(false);
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("serializes nodes and positions when saving", async () => {
    apiMock.updateWorkflow.mockResolvedValue(makeRecord());
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));
    fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiMock.updateWorkflow).toHaveBeenCalledTimes(1);
    });
    const payload = apiMock.updateWorkflow.mock.calls[0]![1] as {
      definition: { nodes: unknown[]; edges: unknown[] };
      metadata: { canvas: { positions: Record<string, { x: number; y: number }> } };
    };
    expect(payload.definition.nodes).toHaveLength(1);
    expect(payload.definition.edges).toEqual([]);
    expect(payload.metadata.canvas.positions).toEqual({
      n_1: { x: 0, y: 0 },
    });
    expect(toastMock.success).toHaveBeenCalledWith("Workflow saved");
  });

  it("renders the validation error strip (D2) when the backend answers 422", async () => {
    apiMock.updateWorkflow.mockRejectedValue(
      new WorkflowValidationErrors("validation failed", [
        { type: "node", id: "n_1", message: "boom: node n_1" },
      ]),
    );
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));
    fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByTestId("workflow-error-list")).toBeTruthy();
    });
    const errorItem = screen.getByText("boom: node n_1");
    expect(errorItem.getAttribute("data-error-id")).toBe("n_1");
    // The error also reaches the shared editor state, which the canvas uses
    // to highlight the offending node.
    expect(toastMock.error).toHaveBeenCalled();
  });

  it("toasts non-validation failures without showing the strip", async () => {
    apiMock.updateWorkflow.mockRejectedValue(new Error("network down"));
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));
    fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Failed to save workflow: network down",
      );
    });
    expect(screen.queryByTestId("workflow-error-list")).toBeNull();
  });

  it("clears the dirty flag after a successful save", async () => {
    apiMock.updateWorkflow.mockResolvedValue(makeRecord());
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));
    fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalled();
    });
    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Save" }) )
        .disabled,
    ).toBe(true);
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("gates Run on a clean document and offers a run-disabled tooltip", () => {
    renderToolbar();

    // Clean document: runnable without a tooltip.
    const runButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Run",
    });
    expect(runButton.disabled).toBe(false);
    expect(runButton.title).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));

    // Unsaved changes: the run is blocked until the document is saved.
    const blockedRun = screen.getByRole<HTMLButtonElement>("button", {
      name: "Run",
    });
    expect(blockedRun.disabled).toBe(true);
    expect(blockedRun.title).toBe("Save unsaved changes first");
  });

  it("swaps Run for Stop and disables Save while a run is active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedStream.mockImplementation(async function* () {
      yield { type: "metadata", runId: "run-1", threadId: "t1" };
      yield { type: "node-started", nodeId: "n_1", step: 1 };
      await gate;
      yield { type: "end" };
    });

    renderToolbar();
    // Clean document: Save is disabled, Run is enabled.
    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Save" }) )
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Save" }) )
        .disabled,
    ).toBe(true);

    // Editing while running must keep Save disabled (isRunning wins over
    // dirty), and Run stays hidden for the whole run.
    fireEvent.click(screen.getByRole("button", { name: "mark-dirty" }));
    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Save" }) )
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();

    release();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    // The run ended but the document is still dirty -> Run stays blocked.
    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Run" }) )
        .disabled,
    ).toBe(true);
  });

  it("keeps Run disabled in readonly mode", () => {
    renderToolbar({ readonly: true });

    expect(
      (screen.getByRole<HTMLButtonElement>("button", { name: "Run" }) )
        .disabled,
    ).toBe(true);
  });
});
