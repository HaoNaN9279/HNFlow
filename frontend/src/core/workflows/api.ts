import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import {
  WorkflowValidationErrors,
  parseWorkflowValidationErrors,
} from "./errors";
import type { WorkflowRunStatus } from "./runs";
import type { WorkflowDefinition, WorkflowRecord } from "./types";

function workflowsUrl(path: string): string {
  return `${getBackendBaseURL()}/api/workflows${path}`;
}

function isValidationErrorDetail(
  detail: unknown,
): detail is { errors: unknown } {
  return (
    typeof detail === "object" &&
    detail !== null &&
    Array.isArray((detail as { errors?: unknown }).errors)
  );
}

/**
 * Throw from a failed workflows response.
 *
 * A 422 carrying `detail: { errors: string[] }` (structural or graph-structure
 * validation) becomes a `WorkflowValidationErrors` so the UI can render the
 * per-node / per-edge list. Other failures keep the FastAPI `detail` string
 * envelope and fall back to the caller-provided message.
 */
async function throwWorkflowApiError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  if (isValidationErrorDetail(body.detail)) {
    throw new WorkflowValidationErrors(
      fallback,
      parseWorkflowValidationErrors(body.detail.errors),
    );
  }
  if (typeof body.detail === "string") {
    throw new Error(body.detail);
  }
  throw new Error(fallback);
}

export type WorkflowPromptPreview = {
  node_id: string;
  prompt: string;
  system_prompt: string;
  task_prompt: string;
  capability_groups: string[];
  omitted_runtime_blocks: string[];
};

/**
 * Ask the backend to assemble an AI node's static text prompt.
 *
 * The current definition is sent so unsaved canvas edits are reflected.  No
 * model/tool call happens; runtime-only memory/retrieval blocks are omitted and
 * reported by the response.
 */
export async function previewWorkflowPrompt(
  workflowId: string,
  body: { node_id: string; definition?: WorkflowDefinition },
): Promise<WorkflowPromptPreview> {
  const response = await fetch(
    workflowsUrl(`/${encodeURIComponent(workflowId)}/prompt-preview`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to preview workflow prompt: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowPromptPreview>;
}

/**
 * Read a workflow run's checkpoint channel values (N14x timing readout).
 *
 * The endpoint returns the `wf:*` channels, which include each node's reserved
 * `wf:<node>:__duration_ms` — the source :func:`extractNodeDurations` reads.
 * An empty object means the run has no checkpoint yet; a non-2xx response
 * throws with the backend `detail` like the other workflow calls.
 */
export async function fetchWorkflowRunState(
  workflowId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    workflowsUrl(
      `/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/state`,
    ),
  );
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to load workflow run state: ${response.statusText}`,
    );
  }
  return response.json() as Promise<Record<string, unknown>>;
}

export type CreateWorkflowPayload = {
  name: string;
  definition: WorkflowDefinition;
  metadata?: Record<string, unknown>;
  version?: string;
};

export type UpdateWorkflowPayload = {
  name?: string;
  definition?: WorkflowDefinition;
  metadata?: Record<string, unknown>;
  version?: string;
};

export async function listWorkflows(): Promise<WorkflowRecord[]> {
  const response = await fetch(workflowsUrl(""));
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to load workflows: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRecord[]>;
}

export async function getWorkflow(id: string): Promise<WorkflowRecord> {
  const response = await fetch(workflowsUrl(`/${encodeURIComponent(id)}`));
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to load workflow: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRecord>;
}

export async function createWorkflow(
  payload: CreateWorkflowPayload,
): Promise<WorkflowRecord> {
  const response = await fetch(workflowsUrl(""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to create workflow: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRecord>;
}

export async function updateWorkflow(
  id: string,
  payload: UpdateWorkflowPayload,
): Promise<WorkflowRecord> {
  const response = await fetch(workflowsUrl(`/${encodeURIComponent(id)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to update workflow: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRecord>;
}

export async function deleteWorkflow(
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const response = await fetch(workflowsUrl(`/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to delete workflow: ${response.statusText}`,
    );
  }
  return response.json() as Promise<{ id: string; deleted: boolean }>;
}

/**
 * One run row from ``GET /api/console/runs`` (Gateway ``ConsoleRunItem``).
 *
 * The console runs endpoint spans every workflow; the list view scopes it with
 * ``assistant_id`` to get one workflow's recent runs.
 */
export type WorkflowConsoleRun = {
  run_id: string;
  thread_id: string;
  thread_title?: string;
  assistant_id?: string;
  status: WorkflowRunStatus;
  created_at?: string;
  updated_at?: string;
  duration_seconds?: number;
  error?: string;
};

/** Page returned by ``listWorkflowRuns`` — ``hasMore`` mirrors ``has_more``. */
export type WorkflowRunsPage = {
  runs: WorkflowConsoleRun[];
  hasMore: boolean;
};

/**
 * List runs for one workflow from the console history endpoint.
 *
 * ``assistant_id`` scopes the query to the workflow and ``limit`` trims the
 * page (the list badge only asks for one). Non-2xx responses — including 503
 * when the SQL/memory backend is unavailable — throw with the backend
 * ``detail`` message when present.
 */
export async function listWorkflowRuns(
  workflowId: string,
  opts?: { limit?: number },
): Promise<WorkflowRunsPage> {
  const params = new URLSearchParams();
  params.set("assistant_id", workflowId);
  if (opts?.limit !== undefined) {
    params.set("limit", String(opts.limit));
  }
  const response = await fetch(
    `${getBackendBaseURL()}/api/console/runs?${params.toString()}`,
  );
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to load workflow runs: ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    runs: WorkflowConsoleRun[];
    has_more: boolean;
  };
  return { runs: body.runs, hasMore: body.has_more };
}
