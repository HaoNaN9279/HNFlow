import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { ProjectContentRecord } from "./types";

function apiUrl(projectId: string, suffix = ""): string {
  return `${getBackendBaseURL()}/api/projects/${encodeURIComponent(projectId)}/content${suffix}`;
}

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { detail?: string };
  return data.detail ?? `HTTP ${response.status}: ${response.statusText}`;
}

export async function loadProjectContent(
  projectId: string,
): Promise<ProjectContentRecord> {
  const response = await fetch(apiUrl(projectId));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as ProjectContentRecord;
}

export async function revealProjectContentFile(
  projectId: string,
  path: string,
): Promise<void> {
  const response = await fetch(apiUrl(projectId, "/reveal"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
