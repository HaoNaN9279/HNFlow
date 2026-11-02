import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

export type WorkspaceResourceChange = {
  id: string;
  seq: number;
  run_id: string | null;
  resource_kind: string;
  resource_id: string;
  parent_id: string | null;
  action: string;
  status: "applied" | "undone" | "failed" | "conflict";
  name: string;
  created_at: string;
  undone_at: string | null;
};

export type WorkspaceResourceChangeList = {
  changes: WorkspaceResourceChange[];
  undoable: {
    run_id: string | null;
    count: number;
    resources: WorkspaceResourceChange[];
  };
};

export type WorkspaceUndoResult = {
  dry_run: boolean;
  run_id: string | null;
  count: number;
  resources: WorkspaceResourceChange[];
};

function apiUrl(threadId: string, suffix = ""): string {
  return `${getBackendBaseURL()}/api/threads/${encodeURIComponent(threadId)}/resource-changes${suffix}`;
}

async function throwApiError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  const detail = body.detail;
  if (typeof detail === "string") {
    throw new Error(detail);
  }
  if (detail && typeof detail === "object") {
    const record = detail as {
      message?: unknown;
      conflicts?: Array<{ detail?: unknown }>;
    };
    if (typeof record.message === "string" && record.message) {
      throw new Error(record.message);
    }
    const conflict = record.conflicts?.[0]?.detail;
    if (typeof conflict === "string" && conflict) {
      throw new Error(conflict);
    }
  }
  throw new Error(fallback);
}

export async function listWorkspaceResourceChanges(
  threadId: string,
): Promise<WorkspaceResourceChangeList> {
  const response = await fetch(apiUrl(threadId), { method: "GET" });
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to load resource changes: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkspaceResourceChangeList>;
}

export async function undoWorkspaceResourceChanges(
  threadId: string,
  payload: { change_id?: string; dry_run?: boolean } = {},
): Promise<WorkspaceUndoResult> {
  const response = await fetch(apiUrl(threadId, "/undo"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to undo resource changes: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkspaceUndoResult>;
}
