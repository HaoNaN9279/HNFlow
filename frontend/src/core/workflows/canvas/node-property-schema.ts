/**
 * Fixed per-node-type parameter schema for the workflow canvas.
 *
 * The canvas no longer offers an arbitrary `params` key/value editor. Every
 * editable param is declared here, and {@link sanitizeNodeParams} drops keys
 * that are not part of the node type's schema. Params owned by the dedicated
 * node forms (instruction, app, subworkflow, ...) are listed in
 * {@link DEDICATED_PARAM_KEYS} so they survive sanitization even though they
 * are edited by those forms.
 */

import type { NodeType } from "./types";

export type NodeParamFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "json";

export type NodeParamField = {
  key: string;
  /** Key under `workflow.properties.params.fields`. */
  labelKey: string;
  kind: NodeParamFieldKind;
  placeholderKey?: string;
  helperKey?: string;
  options?: readonly { value: string; labelKey?: string }[];
  /** Displayed when the param is absent; never written by the form. */
  defaultValue?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** Boolean false either removes the key (default) or is written as false. */
  falseMode?: "delete" | "write";
};

const text = (
  key: string,
  labelKey: string,
  extra: Partial<NodeParamField> = {},
): NodeParamField => ({ key, labelKey, kind: "text", ...extra });

const textarea = (
  key: string,
  labelKey: string,
  extra: Partial<NodeParamField> = {},
): NodeParamField => ({ key, labelKey, kind: "textarea", ...extra });

const number = (
  key: string,
  labelKey: string,
  extra: Partial<NodeParamField> = {},
): NodeParamField => ({ key, labelKey, kind: "number", ...extra });

const boolean = (
  key: string,
  labelKey: string,
  extra: Partial<NodeParamField> = {},
): NodeParamField => ({
  key,
  labelKey,
  kind: "boolean",
  falseMode: "delete",
  ...extra,
});

const json = (
  key: string,
  labelKey: string,
  extra: Partial<NodeParamField> = {},
): NodeParamField => ({ key, labelKey, kind: "json", ...extra });

const select = (
  key: string,
  labelKey: string,
  options: readonly string[],
  extra: Partial<NodeParamField> = {},
): NodeParamField => ({
  key,
  labelKey,
  kind: "select",
  options: options.map((value) => ({ value })),
  ...extra,
});

const CRASH_CONFIRM = boolean("crash_confirm", "crashConfirm", {
  helperKey: "crashConfirmHint",
});

/**
 * Execution-policy fields shared by most node types. `flow:start` and
 * `flow:end` omit breakpoint because the compiler rejects it there.
 */
const COMMON_FIELDS: readonly NodeParamField[] = [
  boolean("breakpoint", "breakpoint"),
  json("idempotency", "idempotency", { helperKey: "jsonHint" }),
  json("merge", "merge", { helperKey: "jsonHint" }),
  boolean("require_approval", "requireApproval"),
  select("on_reject", "onReject", ["fail", "skip"], {
    defaultValue: "fail",
  }),
  boolean("detect_conflicts", "detectConflicts"),
  boolean("rollback_on_failure", "rollbackOnFailure"),
];

const NO_BREAKPOINT_FIELDS = COMMON_FIELDS.filter(
  (field) => field.key !== "breakpoint",
);

const EXTRA_FIELDS: Partial<Record<NodeType, readonly NodeParamField[]>> = {
  "flow:if": [json("ports", "ifPorts", { helperKey: "jsonHint" })],
  "flow:switch": [
    json("cases", "switchCases", { helperKey: "switchCasesHint" }),
  ],
  "flow:loop": [
    number("iterations", "iterations", { defaultValue: 1, min: 1 }),
    text("continue_on", "continueOn"),
    text("seed_input", "seedInput"),
    text("ring_port", "ringPort"),
    json("subworkflow", "subworkflow", { helperKey: "jsonHint" }),
    json("mapping", "mapping", { helperKey: "jsonHint" }),
  ],
  "flow:wait": [number("duration", "duration", { defaultValue: 0, min: 0 })],
  "flow:try": [
    json("subworkflow", "subworkflow", { helperKey: "jsonHint" }),
    json("finally_subworkflow", "finallySubworkflow", {
      helperKey: "jsonHint",
    }),
    json("mapping", "mapping", { helperKey: "jsonHint" }),
    select("on_error", "onError", ["catch", "fail"], {
      defaultValue: "catch",
    }),
    boolean("catch_recursion", "catchRecursion"),
  ],
  "flow:handoff": [
    json("candidates", "handoffCandidates", {
      helperKey: "handoffCandidatesHint",
    }),
    number("max_handoffs", "maxHandoffs", {
      defaultValue: 8,
      min: 1,
      max: 50,
    }),
  ],
  "data:assign": [json("value", "value", { helperKey: "jsonHint" })],
  "data:convert": [
    select("to", "convertTo", ["str", "bool", "int", "float"], {
      defaultValue: "str",
    }),
  ],
  "data:asset": [
    select("operation", "assetOperation", [
      "inspect",
      "import",
      "export",
      "convert",
    ]),
    text("path", "path"),
    text("scope", "assetScope"),
    text("source", "source"),
    boolean("hash", "hash", { falseMode: "write", defaultValue: true }),
    text("contract", "contract"),
    text("destination", "destination"),
    text("destination_path", "destinationPath"),
    text("converter", "converter"),
    CRASH_CONFIRM,
  ],
  "data:shared": [
    select("operation", "sharedOperation", ["read", "write", "append"]),
    text("name", "name"),
    json("value", "value", { helperKey: "jsonHint" }),
  ],
  "data:knowledge": [
    select("operation", "knowledgeOperation", ["retrieve", "ingest"]),
    text("collection", "collection"),
    text("query", "query"),
    text("text", "documentText"),
    text("doc_id", "docId"),
    text("source", "source"),
    number("top_k", "topK", { defaultValue: 5, min: 1 }),
    json("retrieval", "retrieval", { helperKey: "jsonHint" }),
  ],
  "data:file": [
    select("operation", "fileOperation", ["read", "write"]),
    text("path", "path"),
    number("start_line", "startLine", { min: 0 }),
    number("end_line", "endLine", { min: 0 }),
    textarea("content", "content"),
    boolean("append", "append"),
    CRASH_CONFIRM,
  ],
  "data:json": [select("operation", "jsonOperation", ["stringify", "parse"])],
  "data:regex": [text("pattern", "pattern"), text("group", "regexGroup")],
  "tool:bash": [
    textarea("command", "command"),
    json("env", "env", { helperKey: "jsonHint" }),
    number("timeout", "timeout", { min: 0 }),
    CRASH_CONFIRM,
  ],
  "tool:http": [
    select("method", "httpMethod", ["GET", "POST", "PUT", "DELETE", "PATCH"], {
      defaultValue: "GET",
    }),
    text("url", "url"),
    json("headers", "headers", { helperKey: "jsonHint" }),
    json("json", "jsonBody", { helperKey: "jsonHint" }),
    json("params", "queryParams", { helperKey: "jsonHint" }),
    number("timeout", "timeout", { defaultValue: 30, min: 0 }),
    boolean("trust_env", "trustEnv", { falseMode: "write" }),
    CRASH_CONFIRM,
  ],
  "tool:notify": [
    text("title", "title"),
    textarea("message", "message"),
    select("level", "level", ["info", "warning", "error"], {
      defaultValue: "info",
    }),
  ],
  "tool:log": [textarea("message", "message")],
  "tool:invoke": [
    text("tool", "tool"),
    select("provider", "provider", ["sandbox", "builtin", "mcp", "app"]),
    json("arguments", "arguments", { helperKey: "jsonHint" }),
    CRASH_CONFIRM,
  ],
  "ai:llm_agent": [
    json("autonomy", "autonomy", { helperKey: "jsonHint" }),
    json("output_schema", "outputSchema", { helperKey: "jsonHint" }),
    json("context_policy", "contextPolicy", { helperKey: "jsonHint" }),
    json("memory", "memory", { helperKey: "jsonHint" }),
    json("retrieval", "retrieval", { helperKey: "jsonHint" }),
    json("model_policy", "modelPolicy", { helperKey: "jsonHint" }),
  ],
  "human:task": [
    textarea("description", "description"),
    json("output_spec", "outputSpec", { helperKey: "jsonHint" }),
    json("validation_rules", "validationRules", { helperKey: "jsonHint" }),
  ],
  "app:launch": [
    select("mode", "appLaunchMode", ["launch", "attach"], {
      defaultValue: "launch",
    }),
    CRASH_CONFIRM,
  ],
  "app:script": [
    json("args", "args", { helperKey: "jsonHint" }),
    json("env", "env", { helperKey: "jsonHint" }),
    json("conflict_globs", "conflictGlobs", { helperKey: "jsonHint" }),
    boolean("check_presence", "checkPresence"),
    number("undo_steps", "undoSteps", { defaultValue: 1, min: 1 }),
    CRASH_CONFIRM,
  ],
  "app:wait": [
    text("for", "waitFor"),
    number("timeout", "timeout", { min: 0 }),
  ],
  "app:collect": [
    json("globs", "globs", { helperKey: "jsonHint" }),
    boolean("hash", "hash", { falseMode: "write" }),
  ],
  "nested:subworkflow": [boolean("allow_recursion", "allowRecursion")],
};

/**
 * Params owned by the dedicated forms in `workflow-node-form.tsx`. They are
 * never rendered by the generic fixed-param form but must survive
 * sanitization.
 */
const DEDICATED_PARAM_KEYS: Partial<Record<NodeType, readonly string[]>> = {
  "ai:llm_agent": ["instruction", "agent_name", "capability_groups"],
  "ai:capability_group": ["groups"],
  "ai:prompt_preview": ["agent_node"],
  "app:launch": ["app"],
  "app:script": ["app", "script"],
  "app:wait": ["app"],
  "app:collect": ["app"],
  "nested:subworkflow": ["subworkflow", "mapping"],
};

export function getNodeParamFields(type: NodeType): readonly NodeParamField[] {
  const common =
    type === "flow:start" || type === "flow:end"
      ? NO_BREAKPOINT_FIELDS
      : COMMON_FIELDS;
  return [...(EXTRA_FIELDS[type] ?? []), ...common];
}

export function getNodeParamKeys(type: NodeType): ReadonlySet<string> {
  return new Set([
    ...getNodeParamFields(type).map((field) => field.key),
    ...(DEDICATED_PARAM_KEYS[type] ?? []),
  ]);
}

/**
 * Drop params that are not declared for the node type. This is the single
 * compatibility policy: unknown legacy/custom params are deleted on load/save
 * instead of being preserved as a second, untyped parameter channel.
 */
export function sanitizeNodeParams(
  type: NodeType,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = getNodeParamKeys(type);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (allowed.has(key)) {
      next[key] = value;
    }
  }
  return next;
}
