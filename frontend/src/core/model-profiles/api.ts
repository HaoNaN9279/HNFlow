import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { ModelProfile, ModelProfileInput } from "./types";

function apiUrl(path = ""): string {
  return `${getBackendBaseURL()}/api/model-profiles${path}`;
}

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  return typeof data.detail === "string"
    ? data.detail
    : `HTTP ${response.status}: ${response.statusText}`;
}

export async function listModelProfiles(): Promise<ModelProfile[]> {
  const response = await fetch(apiUrl());
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const data = (await response.json()) as { profiles: ModelProfile[] };
  return data.profiles;
}

export async function createModelProfile(
  input: ModelProfileInput,
): Promise<ModelProfile> {
  const response = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as ModelProfile;
}

export async function updateModelProfile(
  id: string,
  input: Partial<ModelProfileInput>,
): Promise<ModelProfile> {
  const response = await fetch(apiUrl(`/${encodeURIComponent(id)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as ModelProfile;
}

export async function deleteModelProfile(id: string): Promise<void> {
  const response = await fetch(apiUrl(`/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
