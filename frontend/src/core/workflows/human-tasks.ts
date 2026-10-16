import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

/**
 * Human-task client for the §25 debug controls (N14ae).
 *
 * A breakpoint and a single step both suspend a node as a `human_tasks` row of
 * the same family the approval gate uses, so the canvas resolves them by
 * submitting (`acknowledge`) or skipping the row — it does not invent a second
 * suspension protocol. Only the two debug kinds are modelled here: the generic
 * `human:task`/`approval` form has arbitrary declared ports and stays with the
 * chat entry (`list_human_tasks` / `submit_human_task`) until it gets its own
 * renderer.
 */

/** Debug pause kinds the canvas can resolve (`kind` on the backend task row). */
export const DEBUG_PAUSE_KINDS = ["breakpoint", "step"] as const;

export type DebugPauseKind = (typeof DEBUG_PAUSE_KINDS)[number];

/**
 * The resume payload a debug pause accepts. The `acknowledge` port is declared
 * `[True]` upstream because LangGraph treats a *falsy* `Command(resume=...)`
 * payload as "not resumed" and suspends the node again — an empty submission
 * would wedge the run, so this is deliberately not `{}`.
 */
export const DEBUG_PAUSE_ACKNOWLEDGEMENT = { acknowledge: true } as const;

/** One normalized human-task row. */
export type HumanTaskRecord = {
  id: string;
  workflowRunId: string;
  nodeId: string;
  kind: string;
  status: string;
  description: string;
};

/** A pending debug pause the run panel can offer to continue or skip. */
export type DebugPause = {
  id: string;
  runId: string;
  nodeId: string;
  kind: DebugPauseKind;
  description: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function isDebugPauseKind(value: unknown): value is DebugPauseKind {
  return (DEBUG_PAUSE_KINDS as readonly unknown[]).includes(value);
}

/** Parse one raw task row, or `null` when it is not a well-formed human task. */
export function parseHumanTask(raw: unknown): HumanTaskRecord | null {
  const record = toRecord(raw);
  const id = stringField(record, "id");
  const workflowRunId = stringField(record, "workflow_run_id");
  const nodeId = stringField(record, "node_id");
  const kind = stringField(record, "kind");
  const status = stringField(record, "status");
  if (
    id === undefined ||
    workflowRunId === undefined ||
    nodeId === undefined ||
    kind === undefined ||
    status === undefined
  ) {
    return null;
  }
  return {
    id,
    workflowRunId,
    nodeId,
    kind,
    status,
    description: stringField(record, "description") ?? "",
  };
}

/**
 * Every pending debug pause an operator can resolve, newest first (the backend
 * already orders by `created_at`), with the open run's own pauses pinned ahead
 * of the rest.
 *
 * Purely task-driven, and deliberately **not** filtered to one run: resuming a
 * pause admits a *new* run, so the follow-up pause of a stepped run carries a
 * run id the canvas has never seen — a run-scoped list would make a stepping
 * run silently unreachable after the first resume. The filter is also the task
 * row's own `status`/`kind` rather than the run status, because a suspended run
 * is `interrupted` on the server while the canvas stream simply ended, and a
 * pending `task`/`approval` row must not be claimed by this card.
 */
export function pendingDebugPauses(
  tasks: readonly HumanTaskRecord[],
  options: { preferredRunId?: string | null } = {},
): DebugPause[] {
  const preferredRunId = options.preferredRunId ?? null;
  const preferred: DebugPause[] = [];
  const others: DebugPause[] = [];
  for (const task of tasks) {
    if (task.status !== "pending" || !isDebugPauseKind(task.kind)) continue;
    const pause: DebugPause = {
      id: task.id,
      runId: task.workflowRunId,
      nodeId: task.nodeId,
      kind: task.kind,
      description: task.description,
    };
    (task.workflowRunId === preferredRunId ? preferred : others).push(pause);
  }
  return [...preferred, ...others];
}

function humanTasksUrl(path = ""): string {
  return `${getBackendBaseURL()}/api/human-tasks${path}`;
}

/** Throw from a failed human-task response (FastAPI `detail`, often `{errors}`). */
async function throwHumanTaskApiError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  if (typeof body.detail === "string") {
    throw new Error(body.detail);
  }
  const errors = toRecord(body.detail)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(errors.map((entry) => String(entry)).join("; "));
  }
  throw new Error(fallback);
}

/** List the current user's pending human tasks (any kind), normalized. */
export async function fetchPendingHumanTasks(): Promise<HumanTaskRecord[]> {
  const response = await fetch(humanTasksUrl("?status=pending"), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    await throwHumanTaskApiError(
      response,
      `Failed to list human tasks: ${response.statusText}`,
    );
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map(parseHumanTask)
    .filter((task): task is HumanTaskRecord => task !== null);
}

/** Submit values for a pending task, which also resumes its suspended run. */
export async function submitHumanTask(
  taskId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    humanTasksUrl(`/${encodeURIComponent(taskId)}/submit`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    },
  );
  if (!response.ok) {
    await throwHumanTaskApiError(
      response,
      `Failed to submit human task: ${response.statusText}`,
    );
  }
}

/** Skip a pending task, which resumes its run with the node's outputs unset. */
export async function skipHumanTask(taskId: string): Promise<void> {
  const response = await fetch(
    humanTasksUrl(`/${encodeURIComponent(taskId)}/skip`),
    { method: "POST" },
  );
  if (!response.ok) {
    await throwHumanTaskApiError(
      response,
      `Failed to skip human task: ${response.statusText}`,
    );
  }
}

/** Acknowledge one debug pause (continue past it) and resume the run. */
export async function continueDebugPause(taskId: string): Promise<void> {
  await submitHumanTask(taskId, { ...DEBUG_PAUSE_ACKNOWLEDGEMENT });
}
