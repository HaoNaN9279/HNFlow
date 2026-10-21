import { describe, expect, it } from "@rstest/core";

import {
  buildWorkflowDirectoryTree,
  workflowFolderOptions,
  workflowFolderPath,
} from "@/core/workflows/folder-tree";
import type { WorkflowRecord } from "@/core/workflows/types";
import type { WorkflowFolder } from "@/core/workflows/workflow-folders";

function folder(
  id: string,
  name: string,
  parent_id: string | null = null,
): WorkflowFolder {
  return {
    id,
    name,
    parent_id,
    user_id: "u",
    order_index: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function workflow(
  id: string,
  name: string,
  folder_id: string | null,
): WorkflowRecord {
  return {
    id,
    name,
    folder_id,
    user_id: "u",
    schema_version: 1,
    definition: {
      id,
      name,
      version: "0.1.0",
      nodes: [],
      edges: [],
      metadata: {},
    },
    metadata: {},
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("workflow folder tree", () => {
  it("builds arbitrary nesting and assigns workflows at every level", () => {
    const folders = [
      folder("a", "A"),
      folder("b", "B", "a"),
      folder("c", "C", "b"),
    ];
    const tree = buildWorkflowDirectoryTree(folders, [
      workflow("root", "Root flow", null),
      workflow("wf-c", "Deep flow", "c"),
    ]);

    expect(tree.workflows.map((item) => item.id)).toEqual(["root"]);
    expect(tree.folders[0]!.folder.id).toBe("a");
    expect(tree.folders[0]!.folders[0]!.folder.id).toBe("b");
    expect(tree.folders[0]!.folders[0]!.folders[0]!.folder.id).toBe("c");
    expect(tree.folders[0]!.folders[0]!.folders[0]!.workflows[0]!.id).toBe(
      "wf-c",
    );
  });

  it("returns the root-to-folder path and flat move options", () => {
    const folders = [
      folder("a", "A"),
      folder("b", "B", "a"),
      folder("c", "C", "b"),
    ];
    expect(workflowFolderPath(folders, "c").map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(workflowFolderPath(folders, null)).toEqual([]);
    expect(
      workflowFolderOptions(folders).map((item) => [item.id, item.depth]),
    ).toEqual([
      [null, 0],
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("treats dangling folder references as root instead of hiding content", () => {
    const tree = buildWorkflowDirectoryTree(
      [],
      [workflow("wf", "Orphan", "missing")],
    );
    expect(tree.workflows.map((item) => item.id)).toEqual(["wf"]);
  });
});
