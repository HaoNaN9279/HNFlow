import { beforeEach, describe, expect, it } from "@rstest/core";

import {
  clearWorkflowDraft,
  readWorkflowDraft,
  readWorkflowSession,
  resolveWorkflowNavPath,
  setWorkflowLocation,
  writeWorkflowDraft,
  type WorkflowSessionStorage,
} from "@/core/workflows/editor-session";

function memoryStorage(): WorkflowSessionStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

let storage: WorkflowSessionStorage;

beforeEach(() => {
  storage = memoryStorage();
});

function writeDirtyDraft(id: string) {
  writeWorkflowDraft(
    id,
    {
      nodes: [],
      edges: [],
      positions: { n1: { x: 1, y: 2 } },
      dirty: true,
    },
    storage,
  );
}

describe("workflow editor session", () => {
  it("starts on the directory", () => {
    expect(readWorkflowSession(storage).location).toEqual({
      kind: "directory",
    });
    expect(resolveWorkflowNavPath(storage)).toBe("/workspace/workflows");
  });

  it("restores the last opened workflow in the sidebar", () => {
    setWorkflowLocation({ kind: "editor", workflowId: "wf 1" }, storage);

    expect(readWorkflowSession(storage).location).toEqual({
      kind: "editor",
      workflowId: "wf 1",
    });
    expect(resolveWorkflowNavPath(storage)).toBe("/workspace/workflows/wf%201");
  });

  it("restores the full editor URL including the breadcrumb trail", () => {
    setWorkflowLocation(
      {
        kind: "editor",
        workflowId: "wf-b",
        href: "/workspace/workflows/wf-b?trail=%5B%5D",
      },
      storage,
    );

    expect(resolveWorkflowNavPath(storage)).toBe(
      "/workspace/workflows/wf-b?trail=%5B%5D",
    );
  });

  it("keeps drafts per workflow and clears only the requested one", () => {
    writeDirtyDraft("wf-1");
    writeDirtyDraft("wf-2");

    expect(readWorkflowDraft("wf-1", storage)?.dirty).toBe(true);
    clearWorkflowDraft("wf-1", storage);

    expect(readWorkflowDraft("wf-1", storage)).toBeNull();
    expect(readWorkflowDraft("wf-2", storage)?.positions).toEqual({
      n1: { x: 1, y: 2 },
    });
  });

  it("ignores malformed stored state", () => {
    storage.setItem("deerflow:workflow-session:v1", "{not-json");
    expect(readWorkflowSession(storage)).toEqual({
      version: 1,
      location: { kind: "directory" },
      drafts: {},
    });
  });
});
