import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import {
  WorkflowValidationErrors,
  parseWorkflowValidationErrors,
} from "./errors";
import type { WorkflowDefinition, WorkflowRecord } from "./types";

function workflowsUrl(path: string): string {
  return `${getBackendBaseURL()}/api/workflows${path}`;
}

function isValidationErrorDetail(detail: unknown): detail is { errors: unknown } {
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
  const response = await fetch(
    workflowsUrl(`/${encodeURIComponent(id)}`),
  );
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
  const response = await fetch(
    workflowsUrl(`/${encodeURIComponent(id)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
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
  const response = await fetch(
    workflowsUrl(`/${encodeURIComponent(id)}`),
    { method: "DELETE" },
  );
  if (!response.ok) {
    await throwWorkflowApiError(
      response,
      `Failed to delete workflow: ${response.statusText}`,
    );
  }
  return response.json() as Promise<{ id: string; deleted: boolean }>;
}
