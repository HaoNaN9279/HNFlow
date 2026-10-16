import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  act,
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { useEffect } from "react";

import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowRunPanel } from "@/components/workspace/workflows/workflow-run-panel";
import { fetchWorkflowRunState } from "@/core/workflows/api";
import {
  streamWorkflowRun,
  type WorkflowRunStreamEvent,
} from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        run: {
          run: "Run",
          runDisabled: "Save unsaved changes first",
          stop: "Stop",
          running: "Running...",
          stopping: "Stopping...",
          runSuccess: "Workflow run finished successfully",
          runFailed: "Workflow run failed",
          cancelFailed: "Failed to cancel run",
          runStatus: {
            pending: "Pending",
            running: "Running",
            success: "Success",
            error: "Failed",
            timeout: "Timed out",
            interrupted: "Interrupted",
          },
          nodeStatus: {
            idle: "Idle",
            running: "Running",
            completed: "Completed",
            failed: "Failed",
          },
          panel: {
            title: "Run",
            idleHint: "Run this workflow to see node status",
            timeline: "Node timeline",
            slowestNode: "Slowest node",
            output: "Output",
            noOutput: "No output",
            errorDetail: "Error",
            terminalStatus: "Result",
          },
        },
      },
    },
  }),
}));

rs.mock("@/core/workflows/runs", () => ({
  streamWorkflowRun: rs.fn(),
  cancelWorkflowRun: rs.fn(),
}));

rs.mock("@/core/workflows/api", () => ({
  fetchWorkflowRunState: rs.fn(),
}));

const mockedStream = rs.mocked(streamWorkflowRun);
const mockedRunState = rs.mocked(fetchWorkflowRunState);

let bridgeStart: (() => Promise<void>) | undefined;

/** Hands the test the context startRun function. */
function EditorBridge() {
  const { startRun } = useWorkflowEditor();
  useEffect(() => {
    bridgeStart = startRun;
  }, [startRun]);
  return null;
}

function makeRecord(): WorkflowRecord {
  return {
    id: "wf-1",
    user_id: "u1",
    name: "Sample",
    schema_version: 1,
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    metadata: {},
    definition: {
      id: "wf-1",
      name: "Sample",
      version: "0.1.0",
      metadata: {},
      nodes: [],
      edges: [],
    },
  };
}

async function* events(
  stream: WorkflowRunStreamEvent[],
): AsyncIterable<WorkflowRunStreamEvent> {
  yield* stream;
}

beforeEach(() => {
  mockedStream.mockReset();
  mockedRunState.mockReset();
  mockedRunState.mockResolvedValue({});
  bridgeStart = undefined;
});

afterEach(() => {
  cleanup();
});

function renderPanel(): RenderResult {
  return render(
    <WorkflowEditorProvider record={makeRecord()}>
      <EditorBridge />
      <WorkflowRunPanel />
    </WorkflowEditorProvider>,
  );
}

describe("WorkflowRunPanel idle state", () => {
  it("shows the idle hint and no status badge", () => {
    const { container } = renderPanel();

    expect(container.textContent).toContain(
      "Run this workflow to see node status",
    );
    expect(container.querySelector('[data-testid="workflow-run-badge"]')).toBe(
      null,
    );
    expect(container.querySelector("[data-timeline-node]")).toBe(null);
    expect(
      container.querySelector('[data-testid="workflow-run-terminal"]'),
    ).toBe(null);
  });
});

describe("WorkflowRunPanel timeline", () => {
  it("renders timeline entries with output, no-output and error details", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        {
          type: "node-completed",
          nodeId: "n-a",
          step: 1,
          output: { ok: true, value: 42 },
        },
        { type: "node-started", nodeId: "n-b", step: 2 },
        { type: "node-completed", nodeId: "n-b", step: 2, output: {} },
        { type: "node-started", nodeId: "n-c", step: 3 },
        { type: "node-failed", nodeId: "n-c", step: 3, error: "boom" },
        { type: "end" },
      ]),
    );

    const { container } = renderPanel();
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });

    // Terminal badge reflects the settled error status.
    const badge = container.querySelector(
      '[data-testid="workflow-run-badge"]',
    )!;
    expect(badge.getAttribute("data-status")).toBe("error");
    expect(badge.textContent).toContain("Failed");

    // Six entries: started/completed for n-a, started/completed for n-b,
    // started/failed for n-c.
    const entries = container.querySelectorAll("[data-timeline-node]");
    expect(entries).toHaveLength(6);
    expect(entries[0]!.getAttribute("data-timeline-status")).toBe("started");
    expect(entries[0]!.getAttribute("data-timeline-node")).toBe("n-a");
    expect(entries[0]!.textContent).toContain("n-a");
    expect(entries[0]!.textContent).toContain("Running");

    // Completed with output: the output is exposed in the details block.
    const withOutput = container.querySelector(
      '[data-timeline-node="n-a"][data-timeline-status="completed"]',
    );
    expect(withOutput).toBeTruthy();
    expect(withOutput!.textContent).toContain("Output");
    expect(withOutput!.textContent).toContain('"ok"');

    // Completed without output: noOutput hint, no Output details.
    const withoutOutput = container.querySelector(
      '[data-timeline-node="n-b"][data-timeline-status="completed"]',
    );
    expect(withoutOutput).toBeTruthy();
    expect(withoutOutput!.textContent).toContain("No output");
    expect(withoutOutput!.textContent).not.toContain("Output");

    // Failed: status label plus the error message.
    const failed = container.querySelector(
      '[data-timeline-node="n-c"][data-timeline-status="failed"]',
    );
    expect(failed).toBeTruthy();
    expect(failed!.textContent).toContain("Failed");
    expect(failed!.textContent).toContain("boom");

    // Terminal block shows the final run status.
    const terminal = container.querySelector(
      '[data-testid="workflow-run-terminal"]',
    );
    expect(terminal).toBeTruthy();
    expect(terminal!.textContent).toContain("Result");
    expect(terminal!.textContent).toContain("Failed");
  });

  it("renders a success terminal badge without a run-level error block", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        {
          type: "node-completed",
          nodeId: "n-a",
          step: 1,
          output: { ok: true },
        },
        { type: "end" },
      ]),
    );

    const { container } = renderPanel();
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });

    const badge = container.querySelector(
      '[data-testid="workflow-run-badge"]',
    )!;
    expect(badge.getAttribute("data-status")).toBe("success");
    expect(badge.textContent).toContain("Success");

    expect(container.querySelector('[data-testid="workflow-run-error"]')).toBe(
      null,
    );
  });

  it("renders the run-level error block from a stream error event", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "error", message: "kaput", name: "ValueError" },
        { type: "end" },
      ]),
    );

    const { container } = renderPanel();
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });

    const errorBlock = container.querySelector(
      '[data-testid="workflow-run-error"]',
    )!;
    expect(errorBlock.textContent).toContain("Error");
    expect(errorBlock.textContent).toContain("kaput");

    // No timeline entries for an empty node sequence.
    expect(container.querySelector("[data-timeline-node]")).toBe(null);
    expect(container.textContent).not.toContain("Node timeline");
  });
});

describe("WorkflowRunPanel node durations (N14x)", () => {
  it("shows per-node timings and the slowest node after a settled run", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        { type: "node-completed", nodeId: "n-a", step: 1, output: {} },
        { type: "node-started", nodeId: "n-b", step: 2 },
        { type: "node-completed", nodeId: "n-b", step: 2, output: {} },
        { type: "end" },
      ]),
    );
    mockedRunState.mockResolvedValue({
      "wf:n-a:__duration_ms": 12.5,
      "wf:n-b:__duration_ms": 1500,
      "wf:n-a:out": "text",
    });

    const { container } = renderPanel();
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });

    // The channels are read from the run-state endpoint for this run.
    await waitFor(() =>
      expect(mockedRunState).toHaveBeenCalledWith("wf-1", "run-1"),
    );

    const badges = container.querySelectorAll(
      '[data-testid="workflow-run-node-duration"]',
    );
    await waitFor(() => expect(badges).toHaveLength(2));
    expect(badges[0]!.getAttribute("data-node")).toBe("n-a");
    expect(badges[0]!.textContent).toBe("12.5 ms");
    expect(badges[1]!.textContent).toBe("1.5 s");

    const slowest = container.querySelector(
      '[data-testid="workflow-run-slowest"]',
    )!;
    expect(slowest.getAttribute("data-node")).toBe("n-b");
    expect(slowest.textContent).toContain("Slowest node");
    expect(slowest.textContent).toContain("1.5 s");
  });

  it("omits the readout when the run state carries no timings", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        { type: "node-completed", nodeId: "n-a", step: 1, output: {} },
        { type: "end" },
      ]),
    );
    mockedRunState.mockResolvedValue({});

    const { container } = renderPanel();
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });
    await waitFor(() => expect(mockedRunState).toHaveBeenCalled());

    expect(
      container.querySelector('[data-testid="workflow-run-node-duration"]'),
    ).toBe(null);
    expect(
      container.querySelector('[data-testid="workflow-run-slowest"]'),
    ).toBe(null);
  });

  it("treats a failed state read as no data (never a run failure)", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        { type: "node-completed", nodeId: "n-a", step: 1, output: {} },
        { type: "end" },
      ]),
    );
    mockedRunState.mockRejectedValue(new Error("state unavailable"));

    const { container } = renderPanel();
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });
    await waitFor(() => expect(mockedRunState).toHaveBeenCalled());

    // The run itself still reports success.
    const badge = container.querySelector(
      '[data-testid="workflow-run-badge"]',
    )!;
    expect(badge.getAttribute("data-status")).toBe("success");
    expect(
      container.querySelector('[data-testid="workflow-run-node-duration"]'),
    ).toBe(null);
  });
});
