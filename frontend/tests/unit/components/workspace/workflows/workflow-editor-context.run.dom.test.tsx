import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import {
  WorkflowEditorProvider,
  useWorkflowRun,
} from "@/components/workspace/workflows/workflow-editor-context";
import { I18nProvider } from "@/core/i18n/context";
import { createInitialRunState } from "@/core/workflows/run-state";
import {
  cancelWorkflowRun,
  streamWorkflowRun,
  type WorkflowRunStreamEvent,
} from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

rs.mock("sonner", () => ({
  toast: { error: rs.fn(), success: rs.fn() },
}));

rs.mock("@/core/workflows/runs", () => ({
  streamWorkflowRun: rs.fn(),
  cancelWorkflowRun: rs.fn(),
}));

const mockedStream = rs.mocked(streamWorkflowRun);
const mockedCancel = rs.mocked(cancelWorkflowRun);
const mockedToastError = rs.mocked(toast.error);

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
      metadata: { canvas: { positions: {} } },
      nodes: [],
      edges: [],
    },
  };
}

function renderRun() {
  return renderHook(() => useWorkflowRun(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider initialLocale="en-US">
        <WorkflowEditorProvider record={makeRecord()}>
          {children}
        </WorkflowEditorProvider>
      </I18nProvider>
    ),
  });
}

async function* events(
  stream: WorkflowRunStreamEvent[],
): AsyncIterable<WorkflowRunStreamEvent> {
  yield* stream;
}

beforeEach(() => {
  mockedStream.mockReset();
  mockedCancel.mockReset();
  mockedToastError.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useWorkflowRun startRun", () => {
  it("streams events into runState and settles success on a clean end", async () => {
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

    const { result } = renderRun();

    await act(async () => {
      await result.current.startRun();
    });

    expect(mockedStream).toHaveBeenCalledWith("wf-1");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.runState.status).toBe("success");
    expect(result.current.runState.runId).toBe("run-1");
    expect(result.current.runState.nodeStates["n-a"]).toBe("completed");
    expect(result.current.runState.timeline).toEqual([
      { nodeId: "n-a", step: 1, status: "started" },
      {
        nodeId: "n-a",
        step: 1,
        status: "completed",
        output: { ok: true },
      },
    ]);
  });

  it("settles error when a node fails", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        { type: "node-failed", nodeId: "n-a", step: 1, error: "boom" },
        { type: "end" },
      ]),
    );

    const { result } = renderRun();

    await act(async () => {
      await result.current.startRun();
    });

    expect(result.current.runState.status).toBe("error");
    expect(result.current.runState.nodeStates["n-a"]).toBe("failed");
    expect(result.current.runState.timeline).toHaveLength(2);
  });

  it("settles error when the stream emits an error event", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "error", message: "kaput", name: "ValueError" },
        { type: "end" },
      ]),
    );

    const { result } = renderRun();

    await act(async () => {
      await result.current.startRun();
    });

    expect(result.current.runState.status).toBe("error");
    expect(result.current.runState.errorMessage).toBe("kaput");
  });

  it("dispatches run-error when the stream throws", async () => {
    mockedStream.mockImplementation(async function* () {
      throw new Error("stream exploded");
    });

    const { result } = renderRun();

    await act(async () => {
      await result.current.startRun();
    });

    expect(result.current.runState.status).toBe("error");
    expect(result.current.runState.errorMessage).toBe("stream exploded");
    expect(result.current.isRunning).toBe(false);
  });
});

describe("useWorkflowRun cancelRun", () => {
  it("calls cancelWorkflowRun with the streamed run id", async () => {
    mockedCancel.mockResolvedValue(undefined);
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        { type: "end" },
      ]),
    );

    const { result } = renderRun();
    await act(async () => {
      await result.current.startRun();
    });

    act(() => {
      void result.current.cancelRun();
    });

    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledWith("wf-1", "run-1");
    });
  });

  it("does nothing when no run id is known", async () => {
    const { result } = renderRun();

    act(() => {
      void result.current.cancelRun();
    });

    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it("settles the finished run interrupted after a successful cancel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedCancel.mockResolvedValue(undefined);
    mockedStream.mockImplementation(async function* () {
      yield { type: "metadata", runId: "run-1", threadId: "t1" };
      yield { type: "node-started", nodeId: "n-a", step: 1 };
      await gate;
      yield { type: "end" };
    });

    const { result } = renderRun();
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.startRun();
    });

    await waitFor(() => {
      expect(result.current.runState.runId).toBe("run-1");
    });
    act(() => {
      void result.current.cancelRun();
    });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalled();
    });

    release();
    await act(async () => {
      await startPromise;
    });

    expect(result.current.runState.status).toBe("interrupted");
  });

  it("toasts when the cancel request fails", async () => {
    mockedCancel.mockRejectedValue(new Error("cannot cancel"));
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "end" },
      ]),
    );

    const { result } = renderRun();
    await act(async () => {
      await result.current.startRun();
    });

    act(() => {
      void result.current.cancelRun();
    });

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalled();
    });
  });
});

describe("useWorkflowRun clearRun", () => {
  it("resets the run state and isRunning", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "end" },
      ]),
    );

    const { result } = renderRun();
    await act(async () => {
      await result.current.startRun();
    });
    expect(result.current.runState.status).toBe("success");

    act(() => {
      result.current.clearRun();
    });

    expect(result.current.runState).toEqual(createInitialRunState());
    expect(result.current.isRunning).toBe(false);
  });
});
