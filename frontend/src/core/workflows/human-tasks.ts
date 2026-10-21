import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

/**
 * Human-task client for the §25 debug controls (N14ae).
 *
 * A breakpoint and a single step both suspend a node as a `human_tasks` row of
 * the same family the review node uses, so the canvas resolves them by
 * submitting (`acknowledge`) or skipping the row — it does not invent a second
 * suspension protocol.  The generic `human:task` form and the dedicated
 * `human:review` form are the two submission renderers.
 */

/** Task kinds the debug controls resolve as a simple continue/skip (§25). */
export const DEBUG_PAUSE_KINDS = ["breakpoint", "step"] as const;

export type DebugPauseKind = (typeof DEBUG_PAUSE_KINDS)[number];

/** The human review node's task kind. */
export const REVIEW_TASK_KIND = "review";

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
  /** What the human must submit — the row's own declaration (never guessed). */
  outputSpec: HumanTaskPort[];
  validationRules: HumanTaskRules;
  /** Human review metadata, when the row carries one. */
  review: ReviewSnapshot | null;
};

/** One declared submission port, as the backend's ``output_spec.ports`` states it. */
export type HumanTaskPort = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

/** The submission constraints the backend enforces (`enum` / `pattern`). */
export type HumanTaskRules = {
  enum: Record<string, unknown[]>;
  pattern: Record<string, string>;
};

/** A human review task's frozen snapshot, defensively reduced. */
export type ReviewSnapshot = {
  visit: number;
  previousRejections: number;
  targetNodeId: string;
  instructions: string;
  input: unknown;
};

/** How a declared port is edited. */
export type HumanTaskFieldKind = "bool" | "number" | "json" | "enum" | "text";

/** One editable field, derived from a port plus its declared rules. */
export type HumanTaskField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  kind: HumanTaskFieldKind;
  /** Allowed values for an `enum` rule, each with its display label. */
  options: { label: string; value: unknown }[] | null;
  /** Declared `pattern` rule, shown as a hint (the backend enforces it). */
  pattern: string | null;
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

function positiveIntegerField(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeIntegerField(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isDebugPauseKind(value: unknown): value is DebugPauseKind {
  return (DEBUG_PAUSE_KINDS as readonly unknown[]).includes(value);
}

/** Reduce the row's ``output_spec`` (defensively — it comes off the wire). */
function parseOutputSpec(raw: unknown): HumanTaskPort[] {
  const ports = toRecord(raw)?.ports;
  if (!Array.isArray(ports)) {
    return [];
  }
  const parsed: HumanTaskPort[] = [];
  for (const entry of ports) {
    const port = toRecord(entry);
    const name = stringField(port, "name");
    if (name === undefined || name === "") {
      continue;
    }
    parsed.push({
      name,
      type: stringField(port, "type") ?? "data",
      required: port?.required === true,
      description: stringField(port, "description") ?? "",
    });
  }
  return parsed;
}

/** Reduce the row's ``validation_rules`` to the two rule kinds it can carry. */
function parseValidationRules(raw: unknown): HumanTaskRules {
  const rules = toRecord(raw);
  const enumRaw = toRecord(rules?.enum);
  const patternRaw = toRecord(rules?.pattern);
  const enumRules: Record<string, unknown[]> = {};
  if (enumRaw !== null) {
    for (const [key, value] of Object.entries(enumRaw)) {
      const entry = toRecord(value)?.enum;
      if (Array.isArray(entry)) {
        enumRules[key] = entry;
      }
    }
  }
  const patternRules: Record<string, string> = {};
  if (patternRaw !== null) {
    for (const [key, value] of Object.entries(patternRaw)) {
      const pattern = stringField(toRecord(value), "pattern");
      if (pattern !== undefined && pattern !== "") {
        patternRules[key] = pattern;
      }
    }
  }
  return { enum: enumRules, pattern: patternRules };
}

/** Reduce a review task's stored snapshot, or ``null`` when absent. */
function parseReviewSnapshot(raw: unknown): ReviewSnapshot | null {
  const snapshot = toRecord(raw);
  if (snapshot?.kind !== REVIEW_TASK_KIND) {
    return null;
  }
  const visit = positiveIntegerField(snapshot, "visit") ?? 1;
  const previousRejections =
    nonNegativeIntegerField(snapshot, "previous_rejections") ??
    Math.max(visit - 1, 0);
  return {
    visit,
    previousRejections,
    targetNodeId: stringField(snapshot, "target_node_id") ?? "",
    instructions: stringField(snapshot, "instructions") ?? "",
    input: snapshot.in,
  };
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
    outputSpec: parseOutputSpec(record?.output_spec),
    validationRules: parseValidationRules(record?.validation_rules),
    review: parseReviewSnapshot(record?.inputs_snapshot),
  };
}

/**
 * The fields a pending task asks the human to fill, in the order the row
 * declares them.  The row's own `output_spec` + `validation_rules` are the only
 * source: the form must ask for exactly what the backend validator will check,
 * no more (an invented field could never be submitted) and no less.
 */
export function humanTaskFields(task: HumanTaskRecord): HumanTaskField[] {
  return task.outputSpec.map((port) => {
    const enumValues = task.validationRules.enum[port.name] ?? null;
    const pattern = task.validationRules.pattern[port.name] ?? null;
    const kind = fieldKind(port.type, enumValues);
    return {
      name: port.name,
      type: port.type,
      required: port.required,
      description: port.description,
      kind,
      options: fieldOptions(kind, enumValues),
      pattern,
    };
  });
}

function fieldKind(
  type: string,
  enumValues: unknown[] | null,
): HumanTaskFieldKind {
  // A declared port type wins over a rule: a review's ``decision`` is a
  // boolean port, so its ``enum: [true, false]`` *constrains the choice* — it
  // does not turn the field into a free-select (whose label "true" would be a
  // string, not the boolean the backend validates).
  if (type === "bool") {
    return "bool";
  }
  if (enumValues !== null && enumValues.length > 0) {
    return "enum";
  }
  switch (type) {
    case "number":
      return "number";
    case "array":
    case "record":
      return "json";
    default:
      return "text";
  }
}

/**
 * The choices a field offers.
 *
 * A boolean port offers exactly the booleans its `enum` rule allows (a
 * breakpoint's `acknowledge` allows only `true`), or both when it declares no
 * rule — never a hand-written label that could disagree with the rule.
 */
function fieldOptions(
  kind: HumanTaskFieldKind,
  enumValues: unknown[] | null,
): { label: string; value: unknown }[] | null {
  if (kind === "bool") {
    const declared =
      enumValues !== null && enumValues.length > 0
        ? enumValues.filter(
            (value): value is boolean => typeof value === "boolean",
          )
        : [];
    const values = declared.length > 0 ? declared : [true, false];
    return values.map((value) => ({ label: String(value), value }));
  }
  if (enumValues === null) {
    return null;
  }
  return enumValues.map((value) => ({ label: formatRuleValue(value), value }));
}

/** Display label for a rule value (JSON so `true` / `"true"` stay distinct). */
export function formatRuleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A draft value as the form stores it before serialization. */
export type HumanTaskDraft = string | boolean | null;

/**
 * Starting drafts for every field.
 *
 * A boolean stays **unset** rather than defaulting to `false`: a review's
 * `false` is a rejection, and an unchecked checkbox would submit one without
 * the human ever choosing.  Everything else starts as empty text.
 */
export function initialHumanTaskDrafts(
  fields: readonly HumanTaskField[],
): Record<string, HumanTaskDraft> {
  const drafts: Record<string, HumanTaskDraft> = {};
  for (const field of fields) {
    drafts[field.name] = field.kind === "bool" ? null : "";
  }
  return drafts;
}

/** Serialize one draft into the value the backend expects, or an error. */
export function serializeHumanTaskValue(
  field: HumanTaskField,
  draft: HumanTaskDraft,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (field.kind === "bool") {
    if (typeof draft !== "boolean") {
      return field.required
        ? { ok: false, error: `${field.name}: 请明确选择 true / false` }
        : { ok: true, value: undefined };
    }
    // Defensive: the widget only offers declared choices, but a stale draft must
    // not slip past the rule the backend will enforce.
    const options = field.options ?? [];
    if (
      options.length > 0 &&
      !options.some((option) => option.value === draft)
    ) {
      return { ok: false, error: `${field.name}: 不在允许的枚举值中` };
    }
    return { ok: true, value: draft };
  }

  const text = typeof draft === "string" ? draft.trim() : "";
  if (text === "") {
    // The backend treats a missing value as absent; for a required field that is
    // a submission error, for an optional one it means "leave the port unset".
    return field.required
      ? { ok: false, error: `${field.name}: 必填` }
      : { ok: true, value: undefined };
  }

  if (field.kind === "enum") {
    const match = (field.options ?? []).find(
      (option) => formatRuleValue(option.value) === text,
    );
    if (match === undefined) {
      return { ok: false, error: `${field.name}: 不在允许的枚举值中` };
    }
    return { ok: true, value: match.value };
  }
  if (field.kind === "number") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: `${field.name}: 需要一个数字` };
    }
    return { ok: true, value: parsed };
  }
  if (field.kind === "json") {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: `${field.name}: 不是合法 JSON` };
    }
  }
  return { ok: true, value: draft };
}

/** Serialize every draft; the first error wins (an all-or-nothing submission). */
export function serializeHumanTaskDrafts(
  fields: readonly HumanTaskField[],
  drafts: Record<string, HumanTaskDraft>,
):
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string } {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const result = serializeHumanTaskValue(field, drafts[field.name] ?? null);
    if (!result.ok) {
      return result;
    }
    if (result.value !== undefined) {
      values[field.name] = result.value;
    }
  }
  return { ok: true, values };
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
 * pending `task`/`review` row must not be claimed by this card.
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

/**
 * Every pending task that needs a *submission* — a ``human:task`` node or a
 * ``human:review`` decision — newest first, with the open run's own pinned
 * ahead.
 *
 * Same reasoning as :func:`pendingDebugPauses`: a resume admits a new run, so a
 * run-scoped list would hide the task a rewind or review just created.  A
 * paused review must stay reachable from the canvas no matter which run
 * started it, because nothing else in the canvas can resolve it.
 */
export function pendingHumanTasks(
  tasks: readonly HumanTaskRecord[],
  options: { preferredRunId?: string | null } = {},
): HumanTaskRecord[] {
  const preferredRunId = options.preferredRunId ?? null;
  const preferred: HumanTaskRecord[] = [];
  const others: HumanTaskRecord[] = [];
  for (const task of tasks) {
    if (task.status !== "pending" || isDebugPauseKind(task.kind)) continue;
    (task.workflowRunId === preferredRunId ? preferred : others).push(task);
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
