import { describe, expect, test } from "@rstest/core";

import {
  createInitialRunState,
  workflowRunReducer,
  type WorkflowRunState,
} from "@/core/workflows/run-state";
import type { WorkflowRunStreamEvent } from "@/core/workflows/runs";

function streamState(
  events: WorkflowRunStreamEvent[],
  initial: WorkflowRunState = createInitialRunState(),
): WorkflowRunState {
  return events.reduce(
    (state, event) =>
      workflowRunReducer(state, { type: "stream-event", event }),
    initial,
  );
}

function startedState(): WorkflowRunState {
  return workflowRunReducer(createInitialRunState(), {
    type: "run-started",
    runId: "run-1",
  });
}

describe("createInitialRunState", () => {
  test("returns an idle, empty state", () => {
    expect(createInitialRunState()).toEqual({
      status: "idle",
      runId: null,
      nodeStates: {},
      timeline: [],
      errorMessage: null,
    });
  });
});

describe("workflowRunReducer", () => {
  test("reset restores the initial state from any state", () => {
    const running = streamState(
      [{ type: "metadata", runId: "run-1", threadId: "t1" }],
      startedState(),
    );
    expect(workflowRunReducer(running, { type: "reset" })).toEqual(
      createInitialRunState(),
    );
  });

  test("run-started resets node state, timeline and error while marking running", () => {
    const state = workflowRunReducer(
      {
        status: "success",
        runId: "old-run",
        nodeStates: { "n-a": "completed" },
        timeline: [{ nodeId: "n-a", step: 1, status: "completed" }],
        errorMessage: "nope",
      },
      { type: "run-started", runId: "run-2" },
    );
    expect(state).toEqual({
      status: "running",
      runId: "run-2",
      nodeStates: {},
      timeline: [],
      errorMessage: null,
    });
  });

  test("node-started marks the node running and appends a started entry", () => {
    const state = streamState([
      { type: "node-started", nodeId: "n-a", step: 1 },
    ]);
    expect(state.nodeStates["n-a"]).toBe("running");
    expect(state.timeline).toEqual([
      { nodeId: "n-a", step: 1, status: "started" },
    ]);
  });

  test("node-completed marks the node completed and carries the output", () => {
    const state = streamState([
      {
        type: "node-completed",
        nodeId: "n-a",
        step: 2,
        output: { result: 42 },
      },
    ]);
    expect(state.nodeStates["n-a"]).toBe("completed");
    expect(state.timeline).toEqual([
      { nodeId: "n-a", step: 2, status: "completed", output: { result: 42 } },
    ]);
  });

  test("node-failed marks the node failed and carries the error", () => {
    const state = streamState([
      { type: "node-failed", nodeId: "n-b", step: 3, error: "boom" },
    ]);
    expect(state.nodeStates["n-b"]).toBe("failed");
    expect(state.timeline).toEqual([
      { nodeId: "n-b", step: 3, status: "failed", error: "boom" },
    ]);
  });

  test("repeat events for one node keep the latest state but append every timeline entry", () => {
    const state = streamState([
      { type: "node-started", nodeId: "n-a", step: 1 },
      { type: "node-completed", nodeId: "n-a", step: 1, output: { v: 1 } },
      { type: "node-started", nodeId: "n-a", step: 2 },
      { type: "node-completed", nodeId: "n-a", step: 2, output: { v: 2 } },
    ]);
    expect(state.nodeStates["n-a"]).toBe("completed");
    expect(state.timeline).toHaveLength(4);
    expect(state.timeline.map((entry) => entry.status)).toEqual([
      "started",
      "completed",
      "started",
      "completed",
    ]);
  });

  test("metadata records the run id when none is set", () => {
    const state = streamState([
      { type: "metadata", runId: "run-1", threadId: "t1" },
    ]);
    expect(state.runId).toBe("run-1");
  });

  test("metadata does not overwrite an already known run id", () => {
    const state = streamState([
      { type: "metadata", runId: "run-1", threadId: "t1" },
      { type: "metadata", runId: "run-2", threadId: "t2" },
    ]);
    expect(state.runId).toBe("run-1");
  });

  test("metadata overwrites the empty placeholder set by run-started", () => {
    const state = workflowRunReducer(
      workflowRunReducer(createInitialRunState(), {
        type: "run-started",
        runId: "",
      }),
      {
        type: "stream-event",
        event: { type: "metadata", runId: "run-9", threadId: "t1" },
      },
    );
    expect(state.runId).toBe("run-9");
  });

  test("an error event records the message without changing the status", () => {
    const state = workflowRunReducer(startedState(), {
      type: "stream-event",
      event: { type: "error", message: "kaput", name: "ValueError" },
    });
    expect(state.errorMessage).toBe("kaput");
    expect(state.status).toBe("running");
  });

  test("run-error marks the run failed with the message", () => {
    const state = workflowRunReducer(startedState(), {
      type: "run-error",
      message: "stream broke",
    });
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("stream broke");
  });

  test("run-ended applies every supported terminal status", () => {
    for (const finalStatus of [
      "success",
      "error",
      "interrupted",
      "timeout",
    ] as const) {
      const state = workflowRunReducer(startedState(), {
        type: "run-ended",
        finalStatus,
      });
      expect(state.status).toBe(finalStatus);
    }
  });

  test("an end event leaves the state untouched", () => {
    const state = streamState([
      { type: "node-started", nodeId: "n-a", step: 1 },
      { type: "end" },
    ]);
    expect(state.status).toBe("idle");
    expect(state.nodeStates["n-a"]).toBe("running");
    expect(state.timeline).toHaveLength(1);
  });
});
