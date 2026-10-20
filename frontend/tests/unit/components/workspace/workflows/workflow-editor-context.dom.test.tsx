import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { I18nProvider } from "@/core/i18n/context";
import { flowToDefinition } from "@/core/workflows/canvas/mapping";
import { writeWorkflowDraft } from "@/core/workflows/editor-session";
import type { WorkflowRecord } from "@/core/workflows/types";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

function makeRecord(): WorkflowRecord {
  return {
    id: "wf-1",
    user_id: "u1",
    name: "Sample",
    schema_version: 1,
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    metadata: {},
    definition: {
      id: "wf-1",
      name: "Sample",
      version: "0.1.0",
      metadata: {
        canvas: {
          positions: {
            "n-a": { x: 0, y: 0 },
            "n-b": { x: 560, y: 0 },
          },
        },
      },
      nodes: [
        {
          id: "n-a",
          type: "flow:start",
          inputs: [],
          outputs: [{ name: "out", type: "data", required: true }],
          params: {},
          capability_groups: [],
          agent_name: null,
        },
        {
          id: "n-b",
          type: "flow:end",
          inputs: [{ name: "in", type: "data", required: true }],
          outputs: [],
          params: {},
          capability_groups: [],
          agent_name: null,
        },
      ],
      edges: [],
    },
  };
}

function renderEditor() {
  return renderHook(() => useWorkflowEditor(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider initialLocale="en-US">
        <WorkflowEditorProvider record={makeRecord()}>
          {children}
        </WorkflowEditorProvider>
      </I18nProvider>
    ),
  });
}

describe("WorkflowEditorProvider canvas positions", () => {
  it("seeds positions from the record definition", async () => {
    const { result } = renderEditor();
    await waitFor(() => {
      expect(result.current.positions).toEqual({
        "n-a": { x: 0, y: 0 },
        "n-b": { x: 560, y: 0 },
      });
    });
  });

  it("deleteNode prunes the deleted node's canvas position", async () => {
    const { result } = renderEditor();
    await waitFor(() => {
      expect(result.current.positions).toHaveProperty("n-a");
    });

    act(() => {
      result.current.deleteNode("n-a");
    });

    expect(result.current.positions).not.toHaveProperty("n-a");
    expect(result.current.positions).toHaveProperty("n-b");
  });

  it("saving after deleteNode does not persist the deleted node's position", async () => {
    const { result } = renderEditor();
    await waitFor(() => {
      expect(result.current.positions).toHaveProperty("n-a");
    });

    act(() => {
      result.current.deleteNode("n-a");
    });

    const { definition } = flowToDefinition(
      { nodes: result.current.nodes, edges: result.current.edges },
      { def: result.current.definition, positions: result.current.positions },
    );
    const positions =
      (
        definition.metadata.canvas as
          | { positions?: Record<string, { x: number; y: number }> }
          | undefined
      )?.positions ?? {};
    expect(positions).not.toHaveProperty("n-a");
    expect(positions).toHaveProperty("n-b");
  });

  it("prunePositions removes several node positions (canvas delete-key path)", async () => {
    const { result } = renderEditor();
    await waitFor(() => {
      expect(result.current.positions).toHaveProperty("n-a");
    });

    act(() => {
      result.current.prunePositions(["n-a", "n-b"]);
    });

    expect(result.current.positions).toEqual({});
  });

  it("restores a dirty tab-scoped draft before the saved record", async () => {
    writeWorkflowDraft("wf-1", {
      nodes: [],
      edges: [],
      positions: { "draft-node": { x: 12, y: 34 } },
      dirty: true,
    });

    const { result } = renderEditor();
    await waitFor(() => {
      expect(result.current.dirty).toBe(true);
      expect(result.current.positions).toEqual({
        "draft-node": { x: 12, y: 34 },
      });
    });
  });

  it("prunePositions with no ids is a no-op", async () => {
    const { result } = renderEditor();
    await waitFor(() => {
      expect(result.current.positions).toHaveProperty("n-a");
    });

    act(() => {
      result.current.prunePositions([]);
    });

    expect(result.current.positions).toEqual({
      "n-a": { x: 0, y: 0 },
      "n-b": { x: 560, y: 0 },
    });
  });
});
