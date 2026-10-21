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
  streamWorkflowRun,
  type WorkflowRunStreamEvent,
} from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

const configMock = rs.hoisted(() => ({ baseUrl: "http://backend.test" }));
const fetchMock = rs.hoisted(() => rs.fn());
const toastMock = rs.hoisted(() => ({ success: rs.fn(), error: rs.fn() }));

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => configMock.baseUrl,
}));

rs.mock("@/core/api/fetcher", () => ({
  fetch: fetchMock,
}));

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
          debugPause: {
            title: "Debug pause",
            hint: "A node is waiting on a breakpoint or in step mode.",
            step: "Step",
            breakpoint: "Breakpoint",
            runHint: (runId: string) => `run ${runId}`,
            continue: "Continue",
            skip: "Skip",
            continued: "Continued — the resumed run has started",
            skipped: "Skipped that node and resumed the run",
            actionFailed: "Action failed",
            loadFailed: "Failed to load waiting debug tasks",
            retry: "Retry",
          },
          humanTask: {
            title: "Waiting human task",
            task: "Human task",
            runHint: (runId: string) => `run ${runId}`,
            noFields: "This task declares no fields to fill in",
            submit: "Submit",
            skip: "Skip",
            skipHint: "Skipping continues as declined",
            required: "required",
            optional: "optional",
            true: "true",
            false: "false",
            patternHint: "Format:",
          },
          review: {
            title: "Human review",
            runHint: (runId: string) => `run ${runId}`,
            attempt: (visit: number) => `Attempt ${visit}`,
            previousRejections: (count: number) =>
              `${count} previous rejections`,
            target: (nodeId: string) => `Reject retries: ${nodeId}`,
            instructions: "Review instructions",
            input: "Submitted result",
            approve: "Approve",
            reject: "Reject",
            feedback: "Continue prompt",
            feedbackHint: "Sent to the agent on rejection.",
            submit: "Submit decision",
            submitting: "Submitting...",
            actionFailed: "Review action failed",
            loadFailed: "Failed to load pending reviews",
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
}));

// The panel imports `fetchWorkflowRunState` from the real api module; keeping
// the module real exercises the same `fetch` seam the panel's own reads use.
const mockedStream = rs.mocked(streamWorkflowRun);

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

function jsonResponse(body: unknown, ok = true, statusText = "OK"): Response {
  return {
    ok,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ht-1",
    workflow_run_id: "run-1",
    node_id: "a",
    kind: "step",
    status: "pending",
    description: "[step] node a paused",
    ...overrides,
  };
}

/** A review row: the fixed decision/feedback spec plus the review snapshot. */
function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ht-review",
    workflow_run_id: "run-1",
    node_id: "review",
    kind: "review",
    status: "pending",
    description: "Check the draft",
    output_spec: {
      ports: [
        { name: "decision", type: "bool", required: true, description: "" },
        { name: "feedback", type: "data", required: false, description: "" },
      ],
    },
    validation_rules: { enum: { decision: { enum: [true, false] } } },
    inputs_snapshot: {
      kind: "review",
      visit: 2,
      previous_rejections: 1,
      target_node_id: "ai_writer",
      instructions: "Check the citations",
      in: { draft: "hello" },
    },
    ...overrides,
  };
}
function readInit(init: unknown): Record<string, unknown> {
  return isRecord(init) ? init : {};
}

/** Route the panel's `fetch` calls: list, submit and skip. */
function routeFetch(options: {
  tasks?: unknown[] | null;
  listFails?: boolean;
  actionFails?: boolean;
}) {
  fetchMock.mockImplementation((url: string, _init?: unknown) => {
    if (url.includes("/api/human-tasks?status=pending")) {
      return Promise.resolve(
        options.listFails === true
          ? jsonResponse({ detail: "boom" }, false, "Internal Server Error")
          : jsonResponse(options.tasks ?? []),
      );
    }
    if (url.includes("/api/human-tasks/")) {
      return Promise.resolve(
        options.actionFails === true
          ? jsonResponse({ detail: "nope" }, false, "Bad Request")
          : jsonResponse({ status: "submitted" }),
      );
    }
    // Any other read (the node-duration probe) answers an empty body.
    return Promise.resolve(jsonResponse({}));
  });
}

function humanTaskCalls(): Array<{
  url: string;
  init: Record<string, unknown>;
}> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes("/api/human-tasks"))
    .map((call) => ({
      url: String(call[0]),
      init: readInit(call[1]),
    }));
}

async function* events(
  stream: WorkflowRunStreamEvent[],
): AsyncIterable<WorkflowRunStreamEvent> {
  yield* stream;
}

beforeEach(() => {
  mockedStream.mockReset();
  fetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  bridgeStart = undefined;
  // The panel's reads are gated on a browser fetch being available.
  Object.defineProperty(globalThis, "fetch", {
    value: rs.fn(),
    configurable: true,
    writable: true,
  });
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

/** Drive one settled run so the panel reaches its terminal reads. */
async function runCompletedOnce(): Promise<HTMLElement> {
  mockedStream.mockImplementation(() =>
    events([
      { type: "metadata", runId: "run-1", threadId: "t1" },
      { type: "node-started", nodeId: "a", step: 1 },
      { type: "node-completed", nodeId: "a", step: 1, output: {} },
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

describe("WorkflowRunPanel debug pauses", () => {
  it("lists a pending step pause and continues it with the acknowledge payload", async () => {
    routeFetch({ tasks: [taskRow()] });
    const container = await runCompletedOnce();

    const card = await waitFor(() => {
      const found = container.querySelector(
        '[data-testid="workflow-debug-pause"]',
      );
      expect(found).toBeTruthy();
      return found!;
    });
    expect(card.getAttribute("data-pause-node")).toBe("a");
    expect(card.getAttribute("data-pause-kind")).toBe("step");
    expect(card.textContent).toContain("[step] node a paused");

    fetchMock.mockClear();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-debug-continue"]',
      )!,
    );

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Continued — the resumed run has started",
      );
    });
    const submit = humanTaskCalls().find((call) =>
      call.url.endsWith("/ht-1/submit"),
    );
    expect(submit).toBeTruthy();
    expect(submit!.init.method).toBe("POST");
    // A falsy resume payload would re-suspend the node, so the acknowledgement
    // must be non-empty.
    expect(JSON.parse(String(submit!.init.body))).toEqual({
      values: { acknowledge: true },
    });
    // The pause list is re-read rather than assumed empty.
    expect(
      humanTaskCalls().some((call) => call.url.includes("?status=pending")),
    ).toBe(true);
  });

  it("skips a pause and reports it", async () => {
    routeFetch({ tasks: [taskRow({ kind: "breakpoint", node_id: "b" })] });
    const container = await runCompletedOnce();

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-debug-skip"]'),
      ).toBeTruthy(),
    );
    fetchMock.mockClear();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-debug-skip"]',
      )!,
    );

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Skipped that node and resumed the run",
      );
    });
    const skip = humanTaskCalls().find((call) =>
      call.url.endsWith("/ht-1/skip"),
    );
    expect(skip).toBeTruthy();
    expect(skip!.init.method).toBe("POST");
  });

  it("keeps a non-debug task out of the debug pause card", async () => {
    routeFetch({
      tasks: [
        taskRow({ kind: "task" }),
        taskRow({ id: "ht-9", status: "submitted" }),
      ],
    });
    const container = await runCompletedOnce();

    await waitFor(() =>
      expect(
        humanTaskCalls().some((call) => call.url.includes("?status=pending")),
      ).toBe(true),
    );
    // A `task` row is a submission (its own form), never a continue/skip pause;
    // the already-submitted row is not offered at all.
    expect(
      container.querySelector('[data-testid="workflow-debug-pause"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="workflow-human-task"]'),
    ).toHaveLength(1);
  });

  it("keeps a paused run reachable even when it is not the panel's own run", async () => {
    routeFetch({ tasks: [taskRow({ workflow_run_id: "run-other" })] });
    const container = await runCompletedOnce();

    const card = await waitFor(() => {
      const found = container.querySelector(
        '[data-testid="workflow-debug-pause"]',
      );
      expect(found).toBeTruthy();
      return found!;
    });
    expect(card.getAttribute("data-pause-run")).toBe("run-other");
  });

  it("reports a failed read instead of claiming there is no pause", async () => {
    routeFetch({ listFails: true });
    const container = await runCompletedOnce();

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-debug-retry"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toContain(
      "Failed to load waiting debug tasks",
    );

    // Retrying with a healthy backend renders the pause.
    routeFetch({ tasks: [taskRow()] });
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-debug-retry"]',
      )!,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-debug-pause"]'),
      ).toBeTruthy(),
    );
  });

  it("surfaces an inline error when the action fails", async () => {
    routeFetch({ tasks: [taskRow()], actionFails: true });
    const container = await runCompletedOnce();

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-debug-continue"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-debug-continue"]',
      )!,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-debug-error"]'),
      ).toBeTruthy(),
    );
    expect(
      container.querySelector('[data-testid="workflow-debug-error"]')!
        .textContent,
    ).toContain("nope");
    expect(toastMock.error).toHaveBeenCalledWith("Action failed");
  });

  it("does not read pauses while the run is still active", async () => {
    async function* neverEnding(): AsyncIterable<WorkflowRunStreamEvent> {
      yield { type: "metadata", runId: "run-1", threadId: "t1" };
      yield { type: "node-started", nodeId: "a", step: 1 };
      await new Promise<void>(() => undefined);
    }
    mockedStream.mockImplementation(neverEnding);
    routeFetch({ tasks: [taskRow()] });
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
      humanTaskCalls().some((call) => call.url.includes("?status=pending")),
    ).toBe(false);
  });
});

describe("WorkflowRunPanel human tasks", () => {
  it("offers the review card for a pending human review", async () => {
    routeFetch({ tasks: [reviewRow()] });
    const container = await runCompletedOnce();

    const form = await waitFor(() => {
      const found = container.querySelector('[data-testid="workflow-review"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(form.getAttribute("data-task-node")).toBe("review");
    expect(form.getAttribute("data-task-visit")).toBe("2");
    expect(form.textContent).toContain("Reject retries: ai_writer");
    expect(form.textContent).toContain("1 previous rejections");
  });
  it("does not route a debug pause into the submission form", async () => {
    routeFetch({ tasks: [taskRow()] });
    const container = await runCompletedOnce();

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-debug-pause"]'),
      ).toBeTruthy(),
    );
    expect(
      container.querySelector('[data-testid="workflow-human-task"]'),
    ).toBeNull();
  });
});
