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
  "data:assign": [
    json("value", "value", { helperKey: "jsonHint" }),
    textarea("task", "taskPrompt", { helperKey: "taskPromptHint" }),
  ],
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
  "data:schema": [],
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
  "data:spec": [
    select("operation", "specOperation", [
      "create",
      "revise",
      "freeze",
      "resolve",
      "lint",
    ]),
    json("spec_ref", "specRef", { helperKey: "specRefHint" }),
    select("language", "specLanguage", ["dafny", "lean", "tla", "cel"], {
      defaultValue: "dafny",
    }),
    textarea("content", "specContent"),
    text("approved_by", "approvedBy"),
    text("approval_task_id", "approvalTaskId"),
    json("metadata", "specMetadata", { helperKey: "jsonHint" }),
  ],
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
  "ai:llm_agent": [],
  "human:task": [
    textarea("description", "description"),
    json("output_spec", "outputSpec", { helperKey: "jsonHint" }),
    json("validation_rules", "validationRules", { helperKey: "jsonHint" }),
  ],
  "human:review": [textarea("instructions", "reviewInstructions")],
  "verify:gate": [
    json("spec_ref", "specRef", { helperKey: "specRefHint" }),
    json("verifier", "verifier", { helperKey: "verifierHint" }),
    json("target", "verifyTarget", { helperKey: "verifyTargetHint" }),
    number("timeout_seconds", "timeout", { defaultValue: 120, min: 1 }),
    textarea("mock_message", "mockMessage"),
    select("mock_mode", "mockMode", ["verified", "failed", "inconclusive"]),
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
  "data:schema": ["schema"],
  "ai:llm_agent": ["agent_name", "model_profile", "capability_groups"],
  "ai:capability_group": ["groups"],
  "ai:prompt_preview": ["agent_node"],
  "app:launch": ["app"],
  "app:script": ["app", "script"],
  "app:wait": ["app"],
  "app:collect": ["app"],
  "nested:subworkflow": ["subworkflow", "mapping"],
};

export function getNodeParamFields(type: NodeType): readonly NodeParamField[] {
  return EXTRA_FIELDS[type] ?? [];
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
