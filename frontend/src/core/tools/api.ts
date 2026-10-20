import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { ToolCatalogEntry } from "./types";

export async function loadTools(): Promise<ToolCatalogEntry[]> {
  const response = await fetch(`${getBackendBaseURL()}/api/tools`);
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      detail?: string;
    };
    throw new Error(
      data.detail ?? `HTTP ${response.status}: ${response.statusText}`,
    );
  }
  const data = (await response.json()) as { tools: ToolCatalogEntry[] };
  return data.tools;
}
