/**
 * Pure logic layer for the workflow node form: parse a `WorkflowNode` into
 * editable form values, write them back without mutating the original, and
 * validate the result.
 *
 * Field locations mirror the backend wire format:
 * - `instruction` → `params.instruction` (required non-empty for `ai:llm_agent`)
 * - `agent_name` / `capability_groups` → node top level (compiler forwards
 *   them into executor params via `setdefault`)
 * - `template_id` / `version` → `params.subworkflow` template spec
 *   (`{type: "template", mode: "compile", template_id, version?}`)
 * - `mapping` → `params.mapping` port wiring for `nested:subworkflow`
 *   (`{inputs: {child_port: parent_ref}, outputs: {child_port: parent_port}}`).
 *   The UI owns the mapping rows; `parse`/`apply` treat the dict as opaque so
 *   literal values and `wf:`-prefixed refs round-trip untouched.
 */

import { AGENT_NAME_PATTERN } from "./node-form-schema";
import type { WorkflowNode } from "./types";

/** Port mapping for a `nested:subworkflow` node, mirroring `params.mapping`. */
export type NodeFormMapping = {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
};

/** Editable values for the node form, keyed by the schema field keys. */
export type NodeFormValues = {
  instruction?: string;
  agent_name?: string;
  capability_groups?: string[];
  template_id?: string;
  version?: string;
  mapping?: NodeFormMapping;
  /** `app:*` nodes — `params.app` (required) and `params.script` (app:script only). */
  app?: string;
  script?: string;
  /** `ai:capability_group` — selected capability-group references. */
  groups?: string[];
  /** `ai:prompt_preview` — the AI node whose final prompt is shown. */
  agent_node?: string;
};

/** Normalised template subworkflow spec extracted from `params.subworkflow`. */
export type SubworkflowSpec = {
  template_id?: string;
  version?: string;
};

/**
 * Extract the template subworkflow spec from `params["subworkflow"]`.
 *
 * Returns `null` when the param is absent, not a plain object, or carries
 * neither usable `template_id` nor `version` — callers treat that as "no spec".
 */
export function parseSubworkflowSpec(
  params: Record<string, unknown>,
): SubworkflowSpec | null {
  const raw = params.subworkflow;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const spec = raw as Record<string, unknown>;
  const templateId =
    typeof spec.template_id === "string" ? spec.template_id : undefined;
  const version = typeof spec.version === "string" ? spec.version : undefined;
  if (templateId === undefined && version === undefined) {
    return null;
  }
  return {
    ...(templateId !== undefined ? { template_id: templateId } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/**
 * Serialise a subworkflow spec into the canonical compile-mode template shape
 * the backend compiler expects. `version` is omitted when empty.
 */
export function serializeSubworkflowSpec(
  spec: SubworkflowSpec,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: "template",
    mode: "compile",
    template_id: spec.template_id ?? "",
  };
  if (spec.version) {
    result.version = spec.version;
  }
  return result;
}

/**
 * Parse the `mapping` payload into a plain string dict per side. Non-dict
 * inputs degrade to an empty dict, and non-string values are dropped so a
 * malformed wire payload cannot reach the form.
 */
function parseMappingDict(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse a raw `params.mapping` value. A non-dict payload degrades to an empty
 * mapping rather than throwing; the caller decides when the key is absent.
 */
function parseMapping(raw: unknown): NodeFormMapping {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { inputs: {}, outputs: {} };
  }
  const mapping = raw as Record<string, unknown>;
  return {
    inputs: parseMappingDict(mapping.inputs),
    outputs: parseMappingDict(mapping.outputs),
  };
}

/**
 * Parse a node into form values. Missing or malformed data degrades to
 * empty values rather than throwing: non-string `instruction` → `""`,
 * `agent_name: null` → `""` (the "None"/lead-agent marker), missing
 * `capability_groups` → `[]`, a non-dict `subworkflow` → no template fields,
 * and an absent `params.mapping` → no `mapping` field. When `params.mapping`
 * exists it always yields a `{inputs, outputs}` shape, so the form can rely
 * on both sides being present.
 */
export function parseNodeFormValues(node: WorkflowNode): NodeFormValues {
  const values: NodeFormValues = {
    instruction:
      typeof node.params.instruction === "string"
        ? node.params.instruction
        : "",
    agent_name: node.agent_name ?? "",
    capability_groups: node.capability_groups
      ? [...node.capability_groups]
      : [],
  };
  const spec = parseSubworkflowSpec(node.params);
  if (spec) {
    if (spec.template_id !== undefined) {
      values.template_id = spec.template_id;
    }
    if (spec.version !== undefined) {
      values.version = spec.version;
    }
  }
  if (node.params.mapping !== undefined) {
    values.mapping = parseMapping(node.params.mapping);
  }
  // `app:*` params are only surfaced when present, so the AI / subworkflow
  // forms never accidentally require an app name.
  if (typeof node.params.app === "string") {
    values.app = node.params.app;
  }
  if (typeof node.params.script === "string") {
    values.script = node.params.script;
  }
  if (Array.isArray(node.params.groups)) {
    values.groups = node.params.groups.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (typeof node.params.agent_node === "string") {
    values.agent_node = node.params.agent_node;
  }
  return values;
}

/**
 * Write form values back into a new node, leaving the original untouched.
 *
 * - `instruction` lands in `params` (other params preserved)
 * - `agent_name` writes the top level; empty/`undefined` → `null` (lead agent)
 * - `capability_groups` writes the top level as a fresh array
 * - `template_id` writes `params.subworkflow` as a compile-mode template spec;
 *   an empty `template_id` removes the `subworkflow` key entirely
 * - `mapping` with any key writes `params.mapping` as a whole (the UI is
 *   responsible for carrying every key that must survive — literals and
 *   `wf:`-prefixed refs included); an empty/`undefined` mapping removes the
 *   key entirely
 */
export function applyNodeFormValues(
  node: WorkflowNode,
  values: NodeFormValues,
): WorkflowNode {
  const params: Record<string, unknown> = {
    ...node.params,
    instruction: values.instruction ?? "",
  };
  // The old user-prompt param was removed from AI nodes; drop it from legacy
  // definitions on the next save so it cannot resurface in the generic editor.
  if (node.type === "ai:llm_agent") {
    delete params.user_prompt;
  }
  const templateId = values.template_id ?? "";
  const existingSubworkflow =
    typeof node.params.subworkflow === "object" &&
    node.params.subworkflow !== null &&
    !Array.isArray(node.params.subworkflow)
      ? (node.params.subworkflow as Record<string, unknown>)
      : null;
  if (templateId) {
    params.subworkflow = serializeSubworkflowSpec({
      template_id: templateId,
      version: values.version,
    });
  } else if (existingSubworkflow?.type === "inline") {
    // Local snapshots have no template id; mapping edits must not delete the
    // embedded definition.
    params.subworkflow = existingSubworkflow;
  } else {
    delete params.subworkflow;
  }
  const mapping = values.mapping;
  if (
    mapping &&
    (Object.keys(mapping.inputs).length > 0 ||
      Object.keys(mapping.outputs).length > 0)
  ) {
    params.mapping = {
      inputs: { ...mapping.inputs },
      outputs: { ...mapping.outputs },
    };
  } else {
    delete params.mapping;
  }
  if (values.app !== undefined) {
    params.app = values.app;
  }
  if (values.script !== undefined) {
    if (values.script) {
      params.script = values.script;
    } else {
      delete params.script;
    }
  }
  if (values.groups !== undefined) {
    params.groups = [...values.groups];
  }
  if (values.agent_node !== undefined) {
    params.agent_node = values.agent_node;
  }
  return {
    ...node,
    params,
    agent_name: values.agent_name === "" ? null : (values.agent_name ?? null),
    capability_groups: values.capability_groups
      ? [...values.capability_groups]
      : [],
  };
}

/**
 * Validate form values. Returns a `Record<fieldKey, errorCode>` with stable
 * string constants (`"required"` | `"invalid"`); i18n happens in the UI layer.
 *
 * Mapping validation mirrors the backend `_validate_subworkflow_mapping`'s
 * parent-side rule: every `mapping.outputs` value must be a non-empty parent
 * port, and — when `node` is supplied with declared outputs — must be one of
 * them. Without a `node` the declared-port check is skipped and only the
 * non-empty rule applies.
 */
export function validateNodeForm(
  values: NodeFormValues,
  node?: Pick<WorkflowNode, "outputs">,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(values.instruction ?? "").trim()) {
    errors.instruction = "required";
  }
  if (!(values.template_id ?? "").trim()) {
    errors.template_id = "required";
  }
  if (values.app !== undefined && !values.app.trim()) {
    errors.app = "required";
  }
  const agentName = values.agent_name;
  if (agentName && !AGENT_NAME_PATTERN.test(agentName)) {
    errors.agent_name = "invalid";
  }
  const mapping = values.mapping;
  if (mapping) {
    const declaredOutputs = node
      ? new Set(node.outputs.map((port) => port.name))
      : null;
    for (const parentPort of Object.values(mapping.outputs)) {
      if (!parentPort.trim()) {
        errors["mapping.outputs"] = "invalid";
        break;
      }
      if (declaredOutputs && !declaredOutputs.has(parentPort)) {
        errors["mapping.outputs"] = "invalid";
        break;
      }
    }
  }
  return errors;
}
