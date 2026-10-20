import type { PositionsMap, RFEdge, RFNode } from "./canvas/mapping";

const SESSION_VERSION = 1;
const SESSION_KEY = "deerflow:workflow-session:v1";

export type WorkflowEditorLocation =
  | { kind: "directory" }
  | { kind: "editor"; workflowId: string };

export type WorkflowEditorDraft = {
  nodes: RFNode[];
  edges: RFEdge[];
  positions: PositionsMap;
  dirty: boolean;
  updatedAt: string;
};

export type WorkflowSessionState = {
  version: typeof SESSION_VERSION;
  location: WorkflowEditorLocation;
  drafts: Record<string, WorkflowEditorDraft>;
};

export type WorkflowSessionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const EMPTY_STATE: WorkflowSessionState = {
  version: SESSION_VERSION,
  location: { kind: "directory" },
  drafts: {},
};

export function getWorkflowSessionStorage(): WorkflowSessionStorage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isLocation(value: unknown): value is WorkflowEditorLocation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { kind?: unknown; workflowId?: unknown };
  if (record.kind === "directory") {
    return true;
  }
  return record.kind === "editor" && typeof record.workflowId === "string";
}

function isDraft(value: unknown): value is WorkflowEditorDraft {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<WorkflowEditorDraft>;
  return (
    Array.isArray(record.nodes) &&
    Array.isArray(record.edges) &&
    typeof record.positions === "object" &&
    record.positions !== null &&
    typeof record.dirty === "boolean" &&
    typeof record.updatedAt === "string"
  );
}

export function readWorkflowSession(
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): WorkflowSessionState {
  if (!storage) {
    return { ...EMPTY_STATE, drafts: {} };
  }
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) {
      return { ...EMPTY_STATE, drafts: {} };
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      location?: unknown;
      drafts?: unknown;
    };
    if (parsed.version !== SESSION_VERSION || !isLocation(parsed.location)) {
      return { ...EMPTY_STATE, drafts: {} };
    }
    const drafts: Record<string, WorkflowEditorDraft> = {};
    if (parsed.drafts && typeof parsed.drafts === "object") {
      for (const [id, draft] of Object.entries(parsed.drafts)) {
        if (isDraft(draft)) {
          drafts[id] = draft;
        }
      }
    }
    return {
      version: SESSION_VERSION,
      location: parsed.location,
      drafts,
    };
  } catch {
    return { ...EMPTY_STATE, drafts: {} };
  }
}

export function writeWorkflowSession(
  state: WorkflowSessionState,
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch {
    // Storage can be disabled or full; editor state must keep working.
  }
}

export function setWorkflowLocation(
  location: WorkflowEditorLocation,
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): void {
  const state = readWorkflowSession(storage);
  writeWorkflowSession({ ...state, location }, storage);
}

export function readWorkflowDraft(
  workflowId: string,
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): WorkflowEditorDraft | null {
  return readWorkflowSession(storage).drafts[workflowId] ?? null;
}

export function writeWorkflowDraft(
  workflowId: string,
  draft: Omit<WorkflowEditorDraft, "updatedAt">,
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): void {
  const state = readWorkflowSession(storage);
  writeWorkflowSession(
    {
      ...state,
      drafts: {
        ...state.drafts,
        [workflowId]: { ...draft, updatedAt: new Date().toISOString() },
      },
    },
    storage,
  );
}

export function clearWorkflowDraft(
  workflowId: string,
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): void {
  const state = readWorkflowSession(storage);
  if (!(workflowId in state.drafts)) {
    return;
  }
  const drafts = { ...state.drafts };
  delete drafts[workflowId];
  writeWorkflowSession({ ...state, drafts }, storage);
}

export function clearWorkflowSession(
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

/** The path the sidebar's Workflows entry should open. */
export function resolveWorkflowNavPath(
  storage: WorkflowSessionStorage | null = getWorkflowSessionStorage(),
): string {
  const { location } = readWorkflowSession(storage);
  if (location.kind === "editor" && location.workflowId) {
    return `/workspace/workflows/${encodeURIComponent(location.workflowId)}`;
  }
  return "/workspace/workflows";
}
