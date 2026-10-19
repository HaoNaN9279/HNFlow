import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { CapabilityGroupDetail, CapabilityGroupSummary } from "./types";

function url(path: string): string {
  return `${getBackendBaseURL()}/api/capability-groups${path}`;
}

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { detail?: string };
  return data.detail ?? `HTTP ${response.status}: ${response.statusText}`;
}

export async function loadCapabilityGroups(): Promise<
  CapabilityGroupSummary[]
> {
  const response = await fetch(url(""));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const data = (await response.json()) as { groups: CapabilityGroupSummary[] };
  return data.groups;
}

export async function loadCapabilityGroup(
  groupId: string,
  version?: string,
): Promise<CapabilityGroupDetail> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const response = await fetch(url(`/${encodeURIComponent(groupId)}${query}`));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as CapabilityGroupDetail;
}

export async function revealCapabilityGroupFile(
  groupId: string,
  path: string,
  version?: string,
): Promise<void> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const response = await fetch(
    url(`/${encodeURIComponent(groupId)}/reveal${query}`),
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
