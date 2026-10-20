/**
 * Pure helpers for `nested:subworkflow` node specs.
 *
 * A subworkflow node is either:
 * - a template reference (`type: "template"`, `template_id`) — the default
 *   "global" save mode: editing the child updates every reference;
 * - an inline snapshot (`type: "inline"`, `definition`) — the "local" save
 *   mode: edits stay inside the parent workflow.
 *
 * `save_mode` is frontend-owned metadata carried inside `params.subworkflow`.
 * The backend compiler ignores unknown spec keys, and inline snapshot support is
 * already part of the workflow schema.
 */

import type { WorkflowDefinition, WorkflowNode } from "./types";

export type SubworkflowSaveMode = "global" | "local";

export type SubworkflowTemplateSource = {
  kind: "template";
  templateId: string;
  version?: string;
  saveMode: "global";
  raw: Record<string, unknown>;
};

export type SubworkflowInlineSource = {
  kind: "inline";
  definition: WorkflowDefinition;
  saveMode: "local";
  sourceTemplateId?: string;
  sourceVersion?: string;
  raw: Record<string, unknown>;
};

export type SubworkflowSource =
  | SubworkflowTemplateSource
  | SubworkflowInlineSource;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Read a node's subworkflow source, or `null` when it declares none. */
export function readSubworkflowSource(
  params: Record<string, unknown>,
): SubworkflowSource | null {
  const raw = asRecord(params.subworkflow);
  if (!raw) {
    return null;
  }
  if (raw.type === "inline") {
    const definition = asRecord(raw.definition);
    if (!definition) {
      return null;
    }
    return {
      kind: "inline",
      definition: definition as unknown as WorkflowDefinition,
      saveMode: "local",
      ...(typeof raw.source_template_id === "string"
        ? { sourceTemplateId: raw.source_template_id }
        : {}),
      ...(typeof raw.source_version === "string"
        ? { sourceVersion: raw.source_version }
        : {}),
      raw,
    };
  }
  if (typeof raw.template_id === "string" && raw.template_id) {
    return {
      kind: "template",
      templateId: raw.template_id,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      saveMode: "global",
      raw,
    };
  }
  return null;
}

/**
 * The node's save mode. Template references default to `global`; inline
 * snapshots are inherently `local` because they have no independent record.
 */
export function readSubworkflowSaveMode(
  params: Record<string, unknown>,
): SubworkflowSaveMode {
  return readSubworkflowSource(params)?.saveMode ?? "global";
}

/** Replace a node's spec with a local snapshot taken from a template. */
export function withLocalSubworkflowSnapshot(
  node: WorkflowNode,
  definition: WorkflowDefinition,
  sourceTemplateId: string,
  sourceVersion?: string,
): WorkflowNode {
  return {
    ...node,
    params: {
      ...node.params,
      subworkflow: {
        type: "inline",
        save_mode: "local",
        source_template_id: sourceTemplateId,
        ...(sourceVersion ? { source_version: sourceVersion } : {}),
        definition,
      },
    },
  };
}

/** Replace a local snapshot with a template reference (global mode). */
export function withGlobalSubworkflowReference(
  node: WorkflowNode,
  templateId: string,
  version?: string,
): WorkflowNode {
  return {
    ...node,
    params: {
      ...node.params,
      subworkflow: {
        type: "template",
        mode: "compile",
        save_mode: "global",
        template_id: templateId,
        ...(version ? { version } : {}),
      },
    },
  };
}

/** The id used to open a child editor, or `null` for an unusable spec. */
export function subworkflowSourceId(
  source: SubworkflowSource | null,
): string | null {
  if (!source) {
    return null;
  }
  return source.kind === "template" ? source.templateId : source.definition.id;
}

/** The display name of the child definition, when one is already available. */
export function subworkflowSourceName(
  source: SubworkflowSource | null,
): string | null {
  if (!source) {
    return null;
  }
  return source.kind === "inline" ? source.definition.name : null;
}
