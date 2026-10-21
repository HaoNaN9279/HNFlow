/**
 * Declarative form schema for workflow node editing (pure logic, zero UI).
 *
 * Each field's `key` matches a member of `NodeFormValues` (see `node-form.ts`);
 * `labelKey` / `helperKey` are i18n dictionary keys — translation happens in
 * the UI layer, not here.
 *
 * The `agent_name` pattern mirrors the backend `AGENT_NAME_PATTERN`
 * (`backend/packages/harness/deerflow/config/agents_config.py`, used with
 * `fullmatch` in the workflow Node schema).
 */

export type NodeFormField = {
  key: string;
  kind: "text" | "textarea" | "select" | "multi-select" | "workflow-template";
  labelKey: string;
  required?: boolean;
  pattern?: RegExp;
  options?: readonly { value: string; labelKey?: string }[];
  helperKey?: string;
};

/** Backend agent-name pattern — `^[A-Za-z0-9-]+$` (fullmatch semantics). */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Fields for the `ai:llm_agent` node form.
 *
 * `agent_name` and `capability_groups` write to the node top level (the
 * compiler forwards them into the executor params via `setdefault`). The
 * `"None"` select option is the UI marker for the default lead-agent binding
 * (`agent_name = null`).
 */
export const AI_NODE_FIELDS: readonly NodeFormField[] = [
  {
    key: "agent_name",
    kind: "select",
    labelKey: "workflow.nodeForm.agentName",
    pattern: AGENT_NAME_PATTERN,
    options: [{ value: "None", labelKey: "workflow.nodeForm.agentNameNone" }],
    helperKey: "workflow.nodeForm.agentNameHelper",
  },
  {
    key: "model_profile",
    kind: "select",
    labelKey: "workflow.nodeForm.modelProfile",
  },
  {
    key: "capability_groups",
    kind: "multi-select",
    labelKey: "workflow.nodeForm.capabilityGroups",
  },
];

/** Fields for the `ai:capability_group` selector. */
export const CAPABILITY_GROUP_FIELDS: readonly NodeFormField[] = [
  {
    key: "groups",
    kind: "multi-select",
    labelKey: "workflow.nodeForm.capabilityGroups",
  },
];

/** Fields for the `ai:prompt_preview` node. */
export const PROMPT_PREVIEW_FIELDS: readonly NodeFormField[] = [
  {
    key: "agent_node",
    kind: "select",
    labelKey: "workflow.nodeForm.promptPreviewAgent",
  },
];

/**
 * Fields for the `nested:subworkflow` node form — both map into
 * `params.subworkflow`. `version` is optional and only shown when set.
 */
export const SUBWORKFLOW_FIELDS: readonly NodeFormField[] = [
  {
    key: "template_id",
    kind: "workflow-template",
    labelKey: "workflow.nodeForm.templateId",
    required: true,
  },
  {
    key: "version",
    kind: "text",
    labelKey: "workflow.nodeForm.version",
  },
];
