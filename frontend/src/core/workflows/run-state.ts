import type { WorkflowRunStreamEvent } from "@/core/workflows/runs";

/** Per-node execution state rendered on the canvas. */
export type NodeRunState = "idle" | "running" | "completed" | "failed";

/**
 * Overall run status. ``idle`` means no run has been started in this editor
 * session; the other values mirror the backend ``WorkflowRunStatus``. There is
 * deliberately no ``cancelled`` value — cancelling keeps the stream running so
 * the backend can settle the run into ``interrupted``/``success``/``error``.
 */
export type RunStatus =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "timeout"
  | "interrupted";

/** One entry in the run timeline; entries are appended, never rewritten. */
export type RunTimelineEntry = {
  nodeId: string;
  step: number;
  status: "started" | "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string;
};

export type WorkflowRunState = {
  status: RunStatus;
  runId: string | null;
  nodeStates: Record<string, NodeRunState>;
  timeline: RunTimelineEntry[];
  errorMessage: string | null;
};

/** Terminal statuses a finished run may settle into. */
export type WorkflowRunFinalStatus = Exclude<RunStatus, "idle" | "running">;

export type WorkflowRunAction =
  | { type: "reset" }
  | { type: "run-started"; runId: string }
  | { type: "stream-event"; event: WorkflowRunStreamEvent }
  | { type: "run-error"; message: string }
  | { type: "run-ended"; finalStatus: WorkflowRunFinalStatus };

export function createInitialRunState(): WorkflowRunState {
  return {
    status: "idle",
    runId: null,
    nodeStates: {},
    timeline: [],
    errorMessage: null,
  };
}

export function workflowRunReducer(
  state: WorkflowRunState,
  action: WorkflowRunAction,
): WorkflowRunState {
  switch (action.type) {
    case "reset":
      return createInitialRunState();
    case "run-started":
      return {
        status: "running",
        runId: action.runId,
        nodeStates: {},
        timeline: [],
        errorMessage: null,
      };
    case "stream-event":
      return reduceStreamEvent(state, action.event);
    case "run-error":
      return { ...state, status: "error", errorMessage: action.message };
    case "run-ended":
      return { ...state, status: action.finalStatus };
  }
}

function reduceStreamEvent(
  state: WorkflowRunState,
  event: WorkflowRunStreamEvent,
): WorkflowRunState {
  switch (event.type) {
    case "metadata": {
      // The stream's metadata frame fills in the run id (and overwrites the
      // empty placeholder dispatched by run-started); a later duplicate frame
      // must not clobber the first id.
      if (state.runId) {
        return state;
      }
      return { ...state, runId: event.runId };
    }
    case "node-started":
      return {
        ...state,
        nodeStates: { ...state.nodeStates, [event.nodeId]: "running" },
        timeline: [
          ...state.timeline,
          { nodeId: event.nodeId, step: event.step, status: "started" },
        ],
      };
    case "node-completed":
      return {
        ...state,
        nodeStates: { ...state.nodeStates, [event.nodeId]: "completed" },
        timeline: [
          ...state.timeline,
          {
            nodeId: event.nodeId,
            step: event.step,
            status: "completed",
            output: event.output,
          },
        ],
      };
    case "node-failed":
      return {
        ...state,
        nodeStates: { ...state.nodeStates, [event.nodeId]: "failed" },
        timeline: [
          ...state.timeline,
          {
            nodeId: event.nodeId,
            step: event.step,
            status: "failed",
            error: event.error,
          },
        ],
      };
    case "error":
      return { ...state, errorMessage: event.message };
    case "end":
      // Terminal status is decided by the run-ended action so the consumer can
      // pick success/error/interrupted/timeout from outside the stream.
      return state;
  }
}
