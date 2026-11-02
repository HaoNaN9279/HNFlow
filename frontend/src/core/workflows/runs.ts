import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

export const WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "timeout",
  "interrupted",
] as const;

/** Mirror of the backend ``RunStatus`` enum. */
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** Run row returned by the workflow run endpoints (Gateway ``RunResponse``). */
export type WorkflowRunRecord = {
  run_id: string;
  thread_id: string;
  status: WorkflowRunStatus;
  assistant_id?: string | null;
  metadata?: Record<string, unknown>;
  kwargs?: Record<string, unknown>;
  multitask_strategy?: string;
  created_at?: string;
  updated_at?: string;
  stop_reason?: string | null;
};

/** Body accepted by ``POST /api/workflows/{id}/runs`` and ``/runs/stream``. */
export type WorkflowRunPayload = {
  params?: Record<string, unknown>;
  thread_id?: string;
  on_disconnect?: string;
  metadata?: Record<string, unknown>;
  /**
   * §25 single-step: pause before every node so an operator advances the run
   * one node per resume. The flag rides the run request, not the definition.
   */
  debug_step?: boolean;
};

/** A normalized event emitted by the workflow run SSE stream. */
export type WorkflowRunStreamEvent =
  | { type: "metadata"; runId: string; threadId: string }
  | { type: "node-started"; nodeId: string; step: number }
  | {
      type: "node-completed";
      nodeId: string;
      step: number;
      output: Record<string, unknown>;
    }
  | { type: "node-failed"; nodeId: string; step: number; error: string }
  | { type: "error"; message: string; name: string }
  | { type: "end" };

function workflowRunsUrl(workflowId: string, path = ""): string {
  return `${getBackendBaseURL()}/api/workflows/${encodeURIComponent(
    workflowId,
  )}/runs${path}`;
}

/** Throw from a failed workflow-run response (standard FastAPI ``detail``). */
async function throwWorkflowRunApiError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  if (typeof body.detail === "string") {
    throw new Error(body.detail);
  }
  throw new Error(fallback);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function mapWorkflowSseEvent(
  eventName: string | null,
  data: unknown,
): WorkflowRunStreamEvent | null {
  if (eventName === "end") {
    return { type: "end" };
  }
  const record = toRecord(data);
  switch (eventName) {
    case "metadata": {
      const runId = stringField(record, "run_id");
      const threadId = stringField(record, "thread_id");
      if (runId === undefined || threadId === undefined) return null;
      return { type: "metadata", runId, threadId };
    }
    case "wf:node:started": {
      const nodeId = stringField(record, "node_id");
      const step = numberField(record, "step");
      if (nodeId === undefined || step === undefined) return null;
      return { type: "node-started", nodeId, step };
    }
    case "wf:node:completed": {
      const nodeId = stringField(record, "node_id");
      const step = numberField(record, "step");
      if (nodeId === undefined || step === undefined) return null;
      return {
        type: "node-completed",
        nodeId,
        step,
        output: toRecord(record?.output) ?? {},
      };
    }
    case "wf:node:failed": {
      const nodeId = stringField(record, "node_id");
      const step = numberField(record, "step");
      if (nodeId === undefined || step === undefined) return null;
      return {
        type: "node-failed",
        nodeId,
        step,
        error: stringField(record, "error") ?? "",
      };
    }
    case "error":
      return {
        type: "error",
        message: stringField(record, "message") ?? "",
        name: stringField(record, "name") ?? "Error",
      };
    default:
      return null;
  }
}

/**
 * Parse one SSE frame (lines of a single event block) into a run event, or
 * ``null`` for unknown/invalid frames. Pure function — unit-tested directly.
 */
export function parseWorkflowSseLine(
  lines: string[],
): WorkflowRunStreamEvent | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  // Without an ``event:`` line, fall back to the data object's ``type``.
  if (eventName === null) {
    const dataType = stringField(toRecord(data), "type");
    if (dataType !== undefined) {
      eventName = dataType;
    }
  }
  return mapWorkflowSseEvent(eventName, data);
}

export async function createWorkflowRun(
  workflowId: string,
  payload?: WorkflowRunPayload,
): Promise<WorkflowRunRecord> {
  const response = await fetch(workflowRunsUrl(workflowId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    await throwWorkflowRunApiError(
      response,
      `Failed to create workflow run: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRunRecord>;
}

export async function getWorkflowRun(
  workflowId: string,
  runId: string,
): Promise<WorkflowRunRecord> {
  const response = await fetch(
    workflowRunsUrl(workflowId, `/${encodeURIComponent(runId)}`),
  );
  if (!response.ok) {
    await throwWorkflowRunApiError(
      response,
      `Failed to load workflow run: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRunRecord>;
}

export async function cancelWorkflowRun(
  workflowId: string,
  runId: string,
): Promise<void> {
  const response = await fetch(
    workflowRunsUrl(workflowId, `/${encodeURIComponent(runId)}/cancel`),
    { method: "POST" },
  );
  if (!response.ok) {
    await throwWorkflowRunApiError(
      response,
      `Failed to cancel workflow run: ${response.statusText}`,
    );
  }
}

/**
 * Continue a completed / interrupted run's AI node in its own session
 * (W2B). Admits a new workflow run that resumes the original run's session
 * checkpoint; ``params`` overrides the inherited defaults when supplied.
 */
export async function continueWorkflowNode(
  workflowId: string,
  runId: string,
  nodeId: string,
  prompt: string,
  params?: Record<string, unknown>,
): Promise<WorkflowRunRecord> {
  const response = await fetch(
    workflowRunsUrl(workflowId, `/${encodeURIComponent(runId)}/continue`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_id: nodeId,
        prompt,
        ...(params !== undefined ? { params } : {}),
      }),
    },
  );
  if (!response.ok) {
    await throwWorkflowRunApiError(
      response,
      `Failed to continue workflow run: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRunRecord>;
}

/**
 * Rewind a finished run and re-execute it from *nodeId* onward (§25). The
 * engine resumes the checkpoint where that node was scheduled, so the nodes
 * before it are not repeated — an upstream side effect must not run twice.
 */
export async function rewindWorkflowRun(
  workflowId: string,
  runId: string,
  nodeId: string,
): Promise<WorkflowRunRecord> {
  const response = await fetch(
    workflowRunsUrl(workflowId, `/${encodeURIComponent(runId)}/rewind`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: nodeId }),
    },
  );
  if (!response.ok) {
    await throwWorkflowRunApiError(
      response,
      `Failed to rewind workflow run: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRunRecord>;
}

/**
 * Create a workflow run and stream its events over SSE. Frames are split on
 * blank lines with a buffer, so events spanning chunk boundaries are joined
 * before parsing; an explicit ``end`` event passes through, and one is emitted
 * when the stream closes without it so consumers always observe a stream end.
 */
export async function* streamWorkflowRun(
  workflowId: string,
  payload?: WorkflowRunPayload,
): AsyncIterable<WorkflowRunStreamEvent> {
  const response = await fetch(workflowRunsUrl(workflowId, "/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    await throwWorkflowRunApiError(
      response,
      `Failed to stream workflow run: ${response.statusText}`,
    );
  }
  if (response.body === null) {
    throw new Error("Workflow run stream response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawEnd = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      for (;;) {
        const separator = buffer.indexOf("\n\n");
        if (separator === -1) break;
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseWorkflowSseLine(frame.split("\n"));
        if (event === null) continue;
        if (event.type === "end") sawEnd = true;
        yield event;
      }
      if (done) break;
    }
    if (buffer.length > 0) {
      const event = parseWorkflowSseLine(buffer.split("\n"));
      if (event !== null) {
        if (event.type === "end") sawEnd = true;
        yield event;
      }
    }
    if (!sawEnd) {
      yield { type: "end" };
    }
  } finally {
    reader.releaseLock();
  }
}
