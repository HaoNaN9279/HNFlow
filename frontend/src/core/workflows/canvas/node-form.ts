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
 */

import { AGENT_NAME_PATTERN } from "./node-form-schema";
import type { WorkflowNode } from "./types";

/** Editable values for the node form, keyed by the schema field keys. */
export type NodeFormValues = {
  instruction?: string;
  agent_name?: string;
  capability_groups?: string[];
  template_id?: string;
  version?: string;
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
export function parseSubworkflowSpec(params: Record<string, unknown>): SubworkflowSpec | null {
  const raw = params.subworkflow;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const spec = raw as Record<string, unknown>;
  const templateId = typeof spec.template_id === "string" ? spec.template_id : undefined;
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
export function serializeSubworkflowSpec(spec: SubworkflowSpec): Record<string, unknown> {
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
 * Parse a node into form values. Missing or malformed data degrades to
 * empty values rather than throwing: non-string `instruction` → `""`,
 * `agent_name: null` → `""` (the "None"/lead-agent marker), missing
 * `capability_groups` → `[]`, and a non-dict `subworkflow` → no template fields.
 */
export function parseNodeFormValues(node: WorkflowNode): NodeFormValues {
  const values: NodeFormValues = {
    instruction: typeof node.params.instruction === "string" ? node.params.instruction : "",
    agent_name: node.agent_name ?? "",
    capability_groups: node.capability_groups ? [...node.capability_groups] : [],
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
 */
export function applyNodeFormValues(node: WorkflowNode, values: NodeFormValues): WorkflowNode {
  const params: Record<string, unknown> = {
    ...node.params,
    instruction: values.instruction ?? "",
  };
  const templateId = values.template_id ?? "";
  if (templateId) {
    params.subworkflow = serializeSubworkflowSpec({
      template_id: templateId,
      version: values.version,
    });
  } else {
    delete params.subworkflow;
  }
  return {
    ...node,
    params,
    agent_name: values.agent_name === "" ? null : values.agent_name ?? null,
    capability_groups: values.capability_groups ? [...values.capability_groups] : [],
  };
}

/**
 * Validate form values. Returns a `Record<fieldKey, errorCode>` with stable
 * string constants (`"required"` | `"invalid"`); i18n happens in the UI layer.
 */
export function validateNodeForm(values: NodeFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(values.instruction ?? "").trim()) {
    errors.instruction = "required";
  }
  if (!(values.template_id ?? "").trim()) {
    errors.template_id = "required";
  }
  const agentName = values.agent_name;
  if (agentName && !AGENT_NAME_PATTERN.test(agentName)) {
    errors.agent_name = "invalid";
  }
  return errors;
}
