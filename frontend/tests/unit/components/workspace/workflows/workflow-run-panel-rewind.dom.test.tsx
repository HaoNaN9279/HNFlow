import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";

import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowRunPanel } from "@/components/workspace/workflows/workflow-run-panel";
import {
  rewindWorkflowRun,
  streamWorkflowRun,
  type WorkflowRunStreamEvent,
} from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

const toastMock = rs.hoisted(() => ({ success: rs.fn(), error: rs.fn() }));

rs.mock("sonner", () => ({ toast: toastMock }));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        run: {
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
          continueSession: "Continue session",
          continuePromptPlaceholder: "Prompt for this AI node…",
          continuePromptSubmit: "Continue",
          continueCancel: "Cancel",
          continueStarted: (runId: string) => `Continue (run ${runId})`,
          rewind: "Rewind & re-run",
          rewindHint: "Re-execute from this node onward",
          rewindStarted: (runId: string) =>
            `Re-ran from this node (run ${runId})`,
          rewindFailed: "Rewind failed",
          debugPause: {
            title: "Debug pause",
            hint: "A node is waiting.",
            step: "Step",
            breakpoint: "Breakpoint",
            runHint: (runId: string) => `run ${runId}`,
            continue: "Continue",
            skip: "Skip",
            continued: "Continued",
            skipped: "Skipped",
            actionFailed: "Action failed",
            loadFailed: "Failed to load waiting debug tasks",
            retry: "Retry",
          },
          panel: {
            title: "Run",
            idleHint: "Run this workflow to see node status",
            timeline: "Node timeline",
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
  continueWorkflowNode: rs.fn(),
  rewindWorkflowRun: rs.fn(),
}));

const mockedStream = rs.mocked(streamWorkflowRun);
const mockedRewind = rs.mocked(rewindWorkflowRun);

let bridgeStart:
  | ((options?: { debugStep?: boolean }) => Promise<void>)
  | undefined;

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
      nodes: [
        {
          id: "a",
          type: "data:assign",
          inputs: [{ name: "in", type: "data" }],
          outputs: [{ name: "out", type: "data" }],
          params: {},
        },
      ],
      edges: [],
    },
  };
}

async function* events(
  stream: WorkflowRunStreamEvent[],
): AsyncIterable<WorkflowRunStreamEvent> {
  yield* stream;
}

/** Drive one settled run so the panel's terminal actions appear. */
async function runSettled(): Promise<HTMLElement> {
  mockedStream.mockImplementation(() =>
    events([
      { type: "metadata", runId: "run-1", threadId: "t1" },
      { type: "node-started", nodeId: "a", step: 1 },
      { type: "node-completed", nodeId: "a", step: 1, output: {} },
      { type: "end" },
    ]),
  );
  const { container } = render(
    <WorkflowEditorProvider record={makeRecord()}>
      <EditorBridge />
      <WorkflowRunPanel />
    </WorkflowEditorProvider>,
  );
  await waitFor(() => expect(bridgeStart).toBeTruthy());
  await act(async () => {
    await bridgeStart!();
  });
  return container;
}

beforeEach(() => {
  mockedStream.mockReset();
  mockedRewind.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  bridgeStart = undefined;
  // The panel's pending-task read is gated on a browser fetch being available.
  Object.defineProperty(globalThis, "fetch", {
    value: rs.fn(async () => ({
      ok: true,
      statusText: "OK",
      json: async () => [],
    })),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("WorkflowRunPanel rewind", () => {
  it("offers a rewind on a settled run's timeline entry", async () => {
    const container = await runSettled();

    const button = container.querySelector(
      '[data-testid="workflow-run-rewind"][data-rewind-node="a"]',
    );
    expect(button).toBeTruthy();
    expect(button!.textContent).toContain("Rewind & re-run");
    expect((button as HTMLElement).getAttribute("title")).toBe(
      "Re-execute from this node onward",
    );
  });

  it("posts the node id and reports the new run", async () => {
    mockedRewind.mockResolvedValue({
      run_id: "run-2",
      thread_id: "t1",
      status: "pending",
    } as never);
    const container = await runSettled();

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-run-rewind"]',
      )!,
    );

    await waitFor(() => expect(mockedRewind).toHaveBeenCalledTimes(1));
    expect(mockedRewind).toHaveBeenCalledWith("wf-1", "run-1", "a");
    expect(toastMock.success).toHaveBeenCalledWith(
      "Re-ran from this node (run run-2)",
    );
  });

  it("surfaces a refusal (e.g. a live run) as an actionable toast", async () => {
    mockedRewind.mockRejectedValue(
      new Error("Run run-1 is not finished (status: running)"),
    );
    const container = await runSettled();

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-run-rewind"]',
      )!,
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Rewind failed: Run run-1 is not finished (status: running)",
      ),
    );
  });

  it("hides the rewind while the run is still active", async () => {
    async function* neverEnding(): AsyncIterable<WorkflowRunStreamEvent> {
      yield { type: "metadata", runId: "run-1", threadId: "t1" };
      yield { type: "node-started", nodeId: "a", step: 1 };
      await new Promise<void>(() => undefined);
    }
    mockedStream.mockImplementation(neverEnding);
    const { container } = render(
      <WorkflowEditorProvider record={makeRecord()}>
        <EditorBridge />
        <WorkflowRunPanel />
      </WorkflowEditorProvider>,
    );
    await waitFor(() => expect(bridgeStart).toBeTruthy());
    act(() => {
      void bridgeStart!();
    });

    await waitFor(() => {
      const badge = container.querySelector(
        '[data-testid="workflow-run-badge"]',
      );
      expect(badge?.getAttribute("data-status")).toBe("running");
    });
    expect(
      container.querySelector('[data-testid="workflow-run-rewind"]'),
    ).toBeNull();
  });
});
