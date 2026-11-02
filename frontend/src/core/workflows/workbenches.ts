import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { WorkflowRunRecord } from "./runs";

export type WorkbenchLayoutCard = {
  member_id: string;
  pinned_run_id?: string | null;
  collapsed?: boolean;
};

export type WorkbenchLayout = {
  version: 1;
  cards: WorkbenchLayoutCard[];
  selected_member_id?: string | null;
};

export type WorkbenchMember = {
  id: string;
  workbench_id: string;
  definition_id: string;
  order_index: number;
  settings: Record<string, unknown>;
  created_at: string;
  definition_name?: string | null;
  definition_version?: string | null;
  definition_exists?: boolean;
};

export type WorkbenchRecord = {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  description: string;
  layout: WorkbenchLayout | Record<string, unknown>;
  settings: Record<string, unknown>;
  revision: number;
  member_count?: number;
  members?: WorkbenchMember[];
  created_at: string;
  updated_at: string;
};

export type MonitorRun = {
  run_id: string;
  thread_id: string;
  definition_id: string | null;
  definition_name: string | null;
  workbench_id: string | null;
  workbench_name: string | null;
  project_id: string | null;
  status: string;
  display_state: string;
  created_at: string | null;
  updated_at: string | null;
  elapsed_seconds: number | null;
  current_node: string | null;
  completed_nodes: number | null;
  total_nodes: number | null;
  pending_human_task_count: number;
  pending_human_task_kinds: string[];
  error_excerpt: string | null;
  workbench_attached: boolean;
};

function apiUrl(path: string): string {
  return `${getBackendBaseURL()}/api${path}`;
}

function projectPath(projectId: string, suffix = ""): string {
  return `/projects/${encodeURIComponent(projectId)}/workbenches${suffix}`;
}

async function throwApiError(
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

export async function listWorkbenches(
  projectId: string,
): Promise<WorkbenchRecord[]> {
  const response = await fetch(apiUrl(projectPath(projectId)));
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to load workbenches: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkbenchRecord[]>;
}

export async function getWorkbench(
  projectId: string,
  id: string,
): Promise<WorkbenchRecord> {
  const response = await fetch(
    apiUrl(projectPath(projectId, `/${encodeURIComponent(id)}`)),
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to load workbench: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkbenchRecord>;
}

export async function createWorkbench(
  projectId: string,
  payload: {
    name: string;
    description?: string;
    layout?: WorkbenchLayout;
    settings?: Record<string, unknown>;
  },
): Promise<WorkbenchRecord> {
  const response = await fetch(apiUrl(projectPath(projectId)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to create workbench: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkbenchRecord>;
}

export async function updateWorkbench(
  projectId: string,
  id: string,
  payload: {
    name?: string;
    description?: string;
    layout?: WorkbenchLayout | Record<string, unknown>;
    settings?: Record<string, unknown>;
    revision?: number;
  },
): Promise<WorkbenchRecord> {
  const response = await fetch(
    apiUrl(projectPath(projectId, `/${encodeURIComponent(id)}`)),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to update workbench: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkbenchRecord>;
}

export async function deleteWorkbench(
  projectId: string,
  id: string,
): Promise<void> {
  const response = await fetch(
    apiUrl(projectPath(projectId, `/${encodeURIComponent(id)}`)),
    { method: "DELETE" },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to delete workbench: ${response.statusText}`,
    );
  }
}

export async function addWorkbenchMember(
  projectId: string,
  workbenchId: string,
  definitionId: string,
): Promise<WorkbenchMember> {
  const response = await fetch(
    apiUrl(
      projectPath(projectId, `/${encodeURIComponent(workbenchId)}/members`),
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition_id: definitionId }),
    },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to add member: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkbenchMember>;
}

export async function removeWorkbenchMember(
  projectId: string,
  workbenchId: string,
  definitionId: string,
): Promise<void> {
  const response = await fetch(
    apiUrl(
      projectPath(
        projectId,
        `/${encodeURIComponent(workbenchId)}/members/${encodeURIComponent(definitionId)}`,
      ),
    ),
    { method: "DELETE" },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to remove member: ${response.statusText}`,
    );
  }
}

export async function createWorkbenchRun(
  projectId: string,
  workbenchId: string,
  payload: {
    definition_id: string;
    params?: Record<string, unknown>;
    debug_step?: boolean;
  },
): Promise<WorkflowRunRecord> {
  const response = await fetch(
    apiUrl(projectPath(projectId, `/${encodeURIComponent(workbenchId)}/runs`)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to start run: ${response.statusText}`,
    );
  }
  return response.json() as Promise<WorkflowRunRecord>;
}

export async function listMonitorRuns(options?: {
  workbenchId?: string | null;
  status?: "active" | "waiting_human" | "all";
}): Promise<MonitorRun[]> {
  const params = new URLSearchParams();
  if (options?.workbenchId) {
    params.set("workbench_id", options.workbenchId);
  }
  params.set("status", options?.status ?? "active");
  const response = await fetch(
    apiUrl(`/workflow-monitor/runs?${params.toString()}`),
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to load running workflows: ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { runs: MonitorRun[] };
  return body.runs;
}
