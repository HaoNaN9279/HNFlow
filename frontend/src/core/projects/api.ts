import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { ProjectRecord } from "./types";

function apiUrl(path: string): string {
  return `${getBackendBaseURL()}/api${path}`;
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

export async function listProjects(): Promise<ProjectRecord[]> {
  const response = await fetch(apiUrl("/projects"));
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to load projects: ${response.statusText}`,
    );
  }
  return response.json() as Promise<ProjectRecord[]>;
}

export async function getProject(projectId: string): Promise<ProjectRecord> {
  const response = await fetch(
    apiUrl(`/projects/${encodeURIComponent(projectId)}`),
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to load project: ${response.statusText}`,
    );
  }
  return response.json() as Promise<ProjectRecord>;
}

export async function openProject(rootPath: string): Promise<ProjectRecord> {
  const response = await fetch(apiUrl("/projects/open"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root_path: rootPath }),
  });
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to open project: ${response.statusText}`,
    );
  }
  return response.json() as Promise<ProjectRecord>;
}

export async function createProject(payload: {
  root_path: string;
  name?: string;
  description?: string;
}): Promise<ProjectRecord> {
  const response = await fetch(apiUrl("/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to create project: ${response.statusText}`,
    );
  }
  return response.json() as Promise<ProjectRecord>;
}

export async function closeProject(projectId: string): Promise<void> {
  const response = await fetch(
    apiUrl(`/projects/${encodeURIComponent(projectId)}`),
    { method: "DELETE" },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      `Failed to close project: ${response.statusText}`,
    );
  }
}
