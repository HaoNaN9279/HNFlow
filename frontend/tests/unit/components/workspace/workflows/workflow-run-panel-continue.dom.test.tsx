import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  act,
  cleanup,
  fireEvent,
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
import {
  continueWorkflowNode,
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
          continueStarted: (runId: string) =>
            `Continue session started (run ${runId})`,
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
}));

const mockedStream = rs.mocked(streamWorkflowRun);
const mockedContinue = rs.mocked(continueWorkflowNode);

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
      nodes: [
        {
          id: "assign",
          type: "data:assign",
          inputs: [{ name: "in", type: "data" }],
          outputs: [{ name: "out", type: "data" }],
          params: {},
        },
        {
          id: "ai_step",
          type: "ai:llm_agent",
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

beforeEach(() => {
  mockedStream.mockReset();
  mockedContinue.mockReset();
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

/** Drive one completed run whose AI node finished successfully. */
async function runCompletedOnce(): Promise<HTMLElement> {
  mockedStream.mockImplementation(() =>
    events([
      { type: "metadata", runId: "run-1", threadId: "t1" },
      { type: "node-started", nodeId: "assign", step: 1 },
      { type: "node-completed", nodeId: "assign", step: 1, output: {} },
      { type: "node-started", nodeId: "ai_step", step: 2 },
      {
        type: "node-completed",
        nodeId: "ai_step",
        step: 2,
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
  return container;
}

describe("WorkflowRunPanel continue session", () => {
  it("shows the continue button only for AI nodes once the run is terminal", async () => {
    const container = await runCompletedOnce();

    const aiButton = container.querySelector(
      '[data-testid="workflow-run-continue"][data-continue-node="ai_step"]',
    );
    expect(aiButton).toBeTruthy();
    expect(aiButton!.textContent).toContain("Continue session");

    // Non-AI nodes get no continue button.
    expect(container.querySelector('[data-continue-node="assign"]')).toBeNull();
  });

  it("submits the prompt and reports the new run via toast", async () => {
    mockedContinue.mockResolvedValue({
      run_id: "run-new",
      thread_id: "t-new",
      status: "pending",
    } as never);
    const container = await runCompletedOnce();

    const continueButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-run-continue"]',
    )!;
    fireEvent.click(continueButton);

    const promptInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="workflow-run-continue-prompt"]',
    )!;
    fireEvent.change(promptInput, { target: { value: "keep going" } });
    const submitButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-run-continue-submit"]',
    )!;
    fireEvent.click(submitButton);

    await waitFor(() => expect(mockedContinue).toHaveBeenCalledTimes(1));
    expect(mockedContinue).toHaveBeenCalledWith(
      "wf-1",
      "run-1",
      "ai_step",
      "keep going",
    );
    // The inline form collapses after a successful continue.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-run-continue-form"]'),
      ).toBeNull(),
    );
  });

  it("surfaces a readable inline error when the continue fails", async () => {
    mockedContinue.mockRejectedValue(
      new Error("Workflow dispatch unavailable"),
    );
    const container = await runCompletedOnce();

    const continueButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-run-continue"]',
    )!;
    fireEvent.click(continueButton);

    const promptInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="workflow-run-continue-prompt"]',
    )!;
    fireEvent.change(promptInput, { target: { value: "keep going" } });
    const submitButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-run-continue-submit"]',
    )!;
    fireEvent.click(submitButton);

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-run-continue-error"]'),
      ).toBeTruthy(),
    );
    const error = container.querySelector(
      '[data-testid="workflow-run-continue-error"]',
    )!;
    expect(error.textContent).toContain("Workflow dispatch unavailable");
  });

  it("does not show the continue button while the run is still running", async () => {
    async function* neverEnding(): AsyncIterable<WorkflowRunStreamEvent> {
      yield { type: "metadata", runId: "run-1", threadId: "t1" };
      yield { type: "node-started", nodeId: "ai_step", step: 1 };
      await new Promise<void>(() => undefined);
    }
    mockedStream.mockImplementation(neverEnding);
    const { container } = renderPanel();
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
      container.querySelector('[data-testid="workflow-run-continue"]'),
    ).toBeNull();
  });
});
