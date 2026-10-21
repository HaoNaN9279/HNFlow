/**
 * Workflow navigation trail encoded in the URL query.
 *
 * The URL always identifies the currently open workflow; `trail` carries the
 * clickable ancestor levels (`A > B` for a child B opened from A). An embedded
 * local subworkflow also carries the root workflow id and the node-id path used
 * to resolve the snapshot from the root definition.
 */

export type WorkflowTrailEntry = {
  id: string;
  name: string;
  /** Root workflow id when this entry is a locally saved subworkflow. */
  localRoot?: string;
  /** Node-id path from the root to the embedded definition. */
  localPath?: string[];
};

export type EmbeddedTrailTarget = {
  localRoot: string;
  localPath: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Parse the `trail` query value, dropping malformed entries. */
export function parseWorkflowTrail(raw: string | null): WorkflowTrailEntry[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: WorkflowTrailEntry[] = [];
  for (const value of parsed) {
    const record = asRecord(value);
    if (!record || typeof record.id !== "string") {
      continue;
    }
    if (typeof record.name !== "string") {
      continue;
    }
    const localPath = Array.isArray(record.localPath)
      ? record.localPath.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
    entries.push({
      id: record.id,
      name: record.name,
      ...(typeof record.localRoot === "string"
        ? { localRoot: record.localRoot }
        : {}),
      ...(localPath && localPath.length > 0 ? { localPath } : {}),
    });
  }
  return entries;
}

export function serializeWorkflowTrail(entries: WorkflowTrailEntry[]): string {
  return JSON.stringify(entries);
}

/** Render a route for one trail level, preserving its own ancestors/target. */
export function workflowHref(
  id: string,
  ancestors: WorkflowTrailEntry[] = [],
  embedded?: EmbeddedTrailTarget,
  workbenchId?: string | null,
): string {
  const params = new URLSearchParams();
  if (ancestors.length > 0) {
    params.set("trail", serializeWorkflowTrail(ancestors));
  }
  if (embedded) {
    params.set("localRoot", embedded.localRoot);
    params.set("localPath", embedded.localPath.join(","));
  }
  if (workbenchId) {
    params.set("workbench", workbenchId);
  }
  const query = params.toString();
  return `/workspace/workflows/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
}

export function hrefForTrailEntry(
  entry: WorkflowTrailEntry,
  ancestors: WorkflowTrailEntry[],
  workbenchId?: string | null,
): string {
  return workflowHref(
    entry.id,
    ancestors,
    entry.localRoot && entry.localPath
      ? { localRoot: entry.localRoot, localPath: entry.localPath }
      : undefined,
    workbenchId,
  );
}

/** Parse the `localPath` query value (comma-separated node ids). */
export function parseLocalPath(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The trail entry describing the currently open editor. */
export function currentTrailEntry(
  id: string,
  name: string,
  embedded?: EmbeddedTrailTarget,
): WorkflowTrailEntry {
  return {
    id,
    name,
    ...(embedded
      ? { localRoot: embedded.localRoot, localPath: embedded.localPath }
      : {}),
  };
}
