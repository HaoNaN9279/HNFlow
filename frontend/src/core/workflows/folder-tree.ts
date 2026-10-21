import type { WorkflowRecord } from "./types";
import type { WorkflowFolder } from "./workflow-folders";

export type WorkflowFolderNode = {
  folder: WorkflowFolder;
  folders: WorkflowFolderNode[];
  workflows: WorkflowRecord[];
};

export type WorkflowDirectoryTree = {
  folders: WorkflowFolderNode[];
  workflows: WorkflowRecord[];
};

/**
 * Build the arbitrary-depth directory tree from flat API rows.
 *
 * A missing parent (a dangling row) is treated as root rather than dropped, so
 * one bad reference can never hide a workflow from the directory.
 */
export function buildWorkflowDirectoryTree(
  folders: readonly WorkflowFolder[],
  workflows: readonly WorkflowRecord[],
): WorkflowDirectoryTree {
  const nodes = new Map<string, WorkflowFolderNode>();
  for (const folder of folders) {
    nodes.set(folder.id, { folder, folders: [], workflows: [] });
  }

  const roots: WorkflowFolderNode[] = [];
  for (const folder of folders) {
    const node = nodes.get(folder.id);
    if (!node) continue;
    const parent = folder.parent_id ? nodes.get(folder.parent_id) : null;
    if (parent) {
      parent.folders.push(node);
    } else {
      roots.push(node);
    }
  }

  const rootWorkflows: WorkflowRecord[] = [];
  for (const workflow of workflows) {
    const node = workflow.folder_id ? nodes.get(workflow.folder_id) : null;
    if (node) {
      node.workflows.push(workflow);
    } else {
      rootWorkflows.push(workflow);
    }
  }

  const sortNodes = (items: WorkflowFolderNode[]) => {
    items.sort(
      (a, b) =>
        a.folder.order_index - b.folder.order_index ||
        a.folder.name.localeCompare(b.folder.name) ||
        a.folder.id.localeCompare(b.folder.id),
    );
    for (const item of items) sortNodes(item.folders);
  };
  sortNodes(roots);
  rootWorkflows.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return { folders: roots, workflows: rootWorkflows };
}

/** Root-to-folder path for a folder id, or `[]` for the root/unknown id. */
export function workflowFolderPath(
  folders: readonly WorkflowFolder[],
  folderId: string | null | undefined,
): WorkflowFolder[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: WorkflowFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

export type WorkflowFolderOption = {
  id: string | null;
  label: string;
  depth: number;
};

/** Flat options for a move-target select, including the root. */
export function workflowFolderOptions(
  folders: readonly WorkflowFolder[],
): WorkflowFolderOption[] {
  const tree = buildWorkflowDirectoryTree(folders, []);
  const options: WorkflowFolderOption[] = [{ id: null, label: "", depth: 0 }];
  const walk = (nodes: WorkflowFolderNode[], depth: number) => {
    for (const node of nodes) {
      options.push({ id: node.folder.id, label: node.folder.name, depth });
      walk(node.folders, depth + 1);
    }
  };
  walk(tree.folders, 0);
  return options;
}
