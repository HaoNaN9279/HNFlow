/**
 * Local ("save inside the parent") subworkflow editing.
 *
 * A local snapshot lives as an inline `params.subworkflow.definition` inside a
 * node. Opening it does not fetch a separate workflow record: the editor
 * resolves the inline definition from the root workflow (its dirty draft wins)
 * along a node-id path, and saving writes the updated definition back into the
 * root workflow's draft.
 */

import {
  definitionToFlow,
  flowToDefinition,
  type RFNode,
} from "./canvas/mapping";
import { readSubworkflowSource } from "./canvas/subworkflow";
import {
  readWorkflowDraft,
  writeWorkflowDraft,
  type WorkflowEditorDraft,
} from "./editor-session";
import type { WorkflowDefinition, WorkflowRecord } from "./types";

export class EmbeddedSubworkflowError extends Error {}

export function embeddedSessionKey(
  rootId: string,
  localPath: string[],
): string {
  return `${rootId}::${localPath.join("/")}`;
}

function rootDraftOrFlow(
  root: WorkflowRecord,
): Pick<WorkflowEditorDraft, "nodes" | "edges" | "positions"> {
  const draft = readWorkflowDraft(root.id);
  if (draft?.dirty) {
    return {
      nodes: draft.nodes,
      edges: draft.edges,
      positions: draft.positions,
    };
  }
  const flow = definitionToFlow(root.definition);
  return {
    nodes: flow.nodes,
    edges: flow.edges,
    positions: flow.positions,
  };
}

/**
 * Resolve the inline definition addressed by `localPath`, starting at the root
 * workflow. Returns `null` when a node is missing or is not an inline snapshot.
 */
export function resolveEmbeddedDefinition(
  root: WorkflowRecord,
  localPath: string[],
): WorkflowDefinition | null {
  if (localPath.length === 0) {
    return root.definition;
  }
  let nodes = rootDraftOrFlow(root).nodes;
  let definition: WorkflowDefinition | null = null;
  for (const [index, nodeId] of localPath.entries()) {
    const node = nodes.find((item) => item.id === nodeId);
    const workflow = node?.data?.workflow;
    if (!workflow) {
      return null;
    }
    const source = readSubworkflowSource(workflow.params);
    if (source?.kind !== "inline") {
      return null;
    }
    definition = source.definition;
    // An intermediate local editor may have unsaved child changes. Its draft is
    // the source of truth for resolving the next level.
    const nestedDraft = readWorkflowDraft(
      embeddedSessionKey(root.id, localPath.slice(0, index + 1)),
    );
    nodes = nestedDraft?.dirty
      ? nestedDraft.nodes
      : definitionToFlow(definition).nodes;
  }
  return definition;
}

/**
 * Replace one inline definition in a node list. Extracted as a pure function so
 * nested local snapshots can be updated recursively and tested without storage.
 */
export function updateEmbeddedDefinitionInNodes(
  nodes: RFNode[],
  localPath: string[],
  definition: WorkflowDefinition,
): RFNode[] {
  const [head, ...rest] = localPath;
  if (!head) {
    throw new EmbeddedSubworkflowError("local subworkflow path is empty");
  }
  const index = nodes.findIndex((node) => node.id === head);
  if (index < 0) {
    throw new EmbeddedSubworkflowError(
      `local subworkflow node '${head}' was not found`,
    );
  }
  const node = nodes[index]!;
  const workflow = node.data?.workflow;
  const source = workflow ? readSubworkflowSource(workflow.params) : null;
  if (!workflow || source?.kind !== "inline") {
    throw new EmbeddedSubworkflowError(
      `node '${head}' is not an inline subworkflow`,
    );
  }

  let nextDefinition: WorkflowDefinition;
  if (rest.length === 0) {
    nextDefinition = definition;
  } else {
    const innerFlow = definitionToFlow(source.definition);
    const updatedNodes = updateEmbeddedDefinitionInNodes(
      innerFlow.nodes,
      rest,
      definition,
    );
    nextDefinition = flowToDefinition(
      { nodes: updatedNodes, edges: innerFlow.edges },
      { def: source.definition, positions: innerFlow.positions },
    ).definition;
  }

  const raw = source.raw;
  const next: RFNode = {
    ...node,
    data: {
      ...node.data,
      workflow: {
        ...workflow,
        params: {
          ...workflow.params,
          subworkflow: { ...raw, definition: nextDefinition },
        },
      },
    },
  };
  const result = [...nodes];
  result[index] = next;
  return result;
}

/** Persist a local child definition into the root workflow's dirty draft. */
export function saveEmbeddedDefinition(
  root: WorkflowRecord,
  localPath: string[],
  definition: WorkflowDefinition,
): void {
  // Deepest parent first: when an intermediate local workflow has its own
  // draft, saving its child belongs in that draft, not in the root workflow.
  if (localPath.length > 1) {
    const parentPath = localPath.slice(0, -1);
    const parentDraft = readWorkflowDraft(
      embeddedSessionKey(root.id, parentPath),
    );
    if (parentDraft?.dirty) {
      writeWorkflowDraft(embeddedSessionKey(root.id, parentPath), {
        ...parentDraft,
        nodes: updateEmbeddedDefinitionInNodes(
          parentDraft.nodes,
          [localPath.at(-1)!],
          definition,
        ),
        dirty: true,
      });
      return;
    }
  }

  const base = rootDraftOrFlow(root);
  const nodes = updateEmbeddedDefinitionInNodes(
    base.nodes,
    localPath,
    definition,
  );
  writeWorkflowDraft(root.id, {
    nodes,
    edges: base.edges,
    positions: base.positions,
    dirty: true,
  });
}

/** Synthetic record the embedded editor mounts for an inline definition. */
export function embeddedWorkflowRecord(
  definition: WorkflowDefinition,
): WorkflowRecord {
  return {
    id: definition.id,
    user_id: "local",
    name: definition.name,
    schema_version: 1,
    definition,
    metadata: definition.metadata as Record<string, unknown>,
    version: definition.version,
    resolved_at: null,
    created_at: "",
    updated_at: "",
  };
}
