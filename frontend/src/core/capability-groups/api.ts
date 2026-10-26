import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { CapabilityGroupDetail, CapabilityGroupSummary } from "./types";

function url(path: string, projectId?: string): string {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return `${getBackendBaseURL()}/api/capability-groups${path}${query}`;
}

function withProjectQuery(path: string, projectId?: string): string {
  if (!projectId) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}project_id=${encodeURIComponent(projectId)}`;
}

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { detail?: string };
  return data.detail ?? `HTTP ${response.status}: ${response.statusText}`;
}

export async function loadCapabilityGroups(
  projectId?: string,
): Promise<CapabilityGroupSummary[]> {
  const response = await fetch(url("", projectId));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const data = (await response.json()) as { groups: CapabilityGroupSummary[] };
  return data.groups;
}

export async function loadCapabilityGroup(
  groupId: string,
  version?: string,
  projectId?: string,
): Promise<CapabilityGroupDetail> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const response = await fetch(
    url(withProjectQuery(`/${encodeURIComponent(groupId)}${query}`, projectId)),
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as CapabilityGroupDetail;
}

export async function revealCapabilityGroupFile(
  groupId: string,
  path: string,
  version?: string,
  projectId?: string,
): Promise<void> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const response = await fetch(
    url(
      withProjectQuery(
        `/${encodeURIComponent(groupId)}/reveal${query}`,
        projectId,
      ),
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

/** Reveal the capability group's own root directory in the host file manager. */
export async function revealCapabilityGroup(
  groupId: string,
  version?: string,
  projectId?: string,
): Promise<void> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const response = await fetch(
    url(
      withProjectQuery(
        `/${encodeURIComponent(groupId)}/reveal${query}`,
        projectId,
      ),
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "." }),
    },
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
