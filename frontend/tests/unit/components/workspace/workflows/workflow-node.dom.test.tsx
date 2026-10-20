import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";

import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowNode } from "@/components/workspace/workflows/workflow-node";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import type { WorkflowNode as WorkflowNodeDef } from "@/core/workflows/canvas/types";
import type { WorkflowValidationError } from "@/core/workflows/errors";
import {
  streamWorkflowRun,
  type WorkflowRunStreamEvent,
} from "@/core/workflows/runs";
import type { WorkflowRecord } from "@/core/workflows/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        renameNodeHint: "Double-click to rename this node",
        run: { cancelFailed: "Failed to cancel run" },
      },
    },
  }),
}));

rs.mock("@/core/workflows/runs", () => ({
  streamWorkflowRun: rs.fn(),
  cancelWorkflowRun: rs.fn(),
}));

const mockedStream = rs.mocked(streamWorkflowRun);

let bridgeStart: (() => Promise<void>) | undefined;
let bridgeSetErrors: ((errors: WorkflowValidationError[]) => void) | undefined;
let bridgeNodes: RFNode[] | undefined;

/** Hands the test the context functions that drive run/node states. */
function EditorBridge() {
  const { nodes, startRun, setErrors } = useWorkflowEditor();
  useEffect(() => {
    bridgeStart = startRun;
    bridgeSetErrors = setErrors;
  }, [setErrors, startRun]);
  useEffect(() => {
    bridgeNodes = nodes;
  }, [nodes]);
  return null;
}

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
      metadata: {},
      nodes: [],
      edges: [],
    },
  };
}

function makeNode(id: string, type: WorkflowNodeDef["type"]): RFNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      workflow: {
        id,
        type,
        inputs: [],
        outputs: [],
        params: {},
        capability_groups: [],
        agent_name: null,
      },
    },
  };
}

/** The full NodeProps surface WorkflowNode requires, with test defaults. */
function nodeProps(node: RFNode) {
  return {
    id: node.id,
    data: node.data,
    type: node.type ?? node.data.workflow.type,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected: false,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

async function* events(
  stream: WorkflowRunStreamEvent[],
): AsyncIterable<WorkflowRunStreamEvent> {
  yield* stream;
}

beforeEach(() => {
  mockedStream.mockReset();
  bridgeStart = undefined;
  bridgeSetErrors = undefined;
  bridgeNodes = undefined;
  // The editor mirrors dirty canvases into sessionStorage; without clearing it
  // a previous test's draft seeds the next provider with the wrong nodes.
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

function renderNodes(nodes: RFNode[]): RenderResult {
  const record = makeRecord();
  record.definition = {
    ...record.definition,
    nodes: nodes.map((node) => node.data.workflow),
  };
  return render(
    <ReactFlowProvider>
      <WorkflowEditorProvider record={record}>
        <EditorBridge />
        {nodes.map((node) => (
          <WorkflowNode key={node.id} {...nodeProps(node)} />
        ))}
      </WorkflowEditorProvider>
    </ReactFlowProvider>,
  );
}

/** Locate the rendered node card for a node type. */
function nodeCard(container: HTMLElement, type: string): HTMLElement {
  const element = container.querySelector(`[data-node-type="${type}"]`);
  expect(element).toBeTruthy();
  return element as HTMLElement;
}

describe("WorkflowNode card content", () => {
  it("renders every param and keeps handles vertically inside their port rows", () => {
    const node = makeNode("n-params", "data:assign");
    node.data.workflow.inputs = [{ name: "in", type: "data" }];
    node.data.workflow.outputs = [{ name: "out", type: "data" }];
    node.data.workflow.params = { value: "hello", tempo: 120 };
    const { container } = renderNodes([node]);
    const card = nodeCard(container, "data:assign");

    expect(card.textContent).toContain("value");
    expect(card.textContent).toContain("hello");
    expect(card.textContent).toContain("tempo");
    expect(card.textContent).toContain("120");

    const handles = card.querySelectorAll<HTMLElement>(".react-flow__handle");
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.style.top).toBe("50%");
    }
  });

  it("shows the custom display name above the fixed node name", () => {
    const node = makeNode("n-start", "flow:start");
    node.data.displayName = "Entry point";
    const { container } = renderNodes([node]);
    const card = nodeCard(container, "flow:start");

    const displayName = card.querySelector<HTMLElement>(
      '[data-testid="workflow-node-display-name"]',
    );
    const defaultName = card.querySelector<HTMLElement>(
      '[data-testid="workflow-node-default-name"]',
    );

    expect(displayName?.textContent).toBe("Entry point");
    expect(defaultName?.textContent).toBe("Start");
    expect(displayName?.parentElement?.className).toContain("text-sm");
    expect(defaultName?.className).toContain("text-xs");
    expect(defaultName?.className).toContain("text-muted-foreground");
  });

  it("renames a node on double click and commits with Enter", async () => {
    const { container } = renderNodes([makeNode("n-rename", "flow:start")]);
    const card = nodeCard(container, "flow:start");
    await waitFor(() =>
      expect(bridgeNodes?.some((node) => node.id === "n-rename")).toBe(true),
    );

    fireEvent.doubleClick(
      card.querySelector('[data-testid="workflow-node-display-name"]')!,
    );
    const input = card.querySelector<HTMLInputElement>(
      '[data-testid="workflow-node-name-input"]',
    );
    expect(input).toBeTruthy();

    fireEvent.change(input!, { target: { value: "Begin here" } });
    fireEvent.keyDown(input!, { key: "Enter" });

    await waitFor(() => {
      expect(
        bridgeNodes?.find((node) => node.id === "n-rename")?.data.displayName,
      ).toBe("Begin here");
    });
  });

  it("cancels a rename with Escape", async () => {
    const { container } = renderNodes([makeNode("n-escape", "flow:start")]);
    const card = nodeCard(container, "flow:start");
    await waitFor(() =>
      expect(bridgeNodes?.some((node) => node.id === "n-escape")).toBe(true),
    );

    fireEvent.doubleClick(
      card.querySelector('[data-testid="workflow-node-display-name"]')!,
    );
    const input = card.querySelector<HTMLInputElement>(
      '[data-testid="workflow-node-name-input"]',
    );
    fireEvent.change(input!, { target: { value: "Discarded" } });
    fireEvent.keyDown(input!, { key: "Escape" });

    expect(
      bridgeNodes?.find((node) => node.id === "n-escape")?.data.displayName,
    ).toBeUndefined();
    expect(
      card.querySelector('[data-testid="workflow-node-name-input"]'),
    ).toBeNull();
  });
});

describe("WorkflowNode run-state painting", () => {
  it("renders data-run-state idle without a run tint", () => {
    const { container } = renderNodes([
      makeNode("n-a", "flow:start"),
      makeNode("n-b", "flow:end"),
      makeNode("n-c", "flow:wait"),
    ]);

    expect(
      nodeCard(container, "flow:start").getAttribute("data-run-state"),
    ).toBe("idle");
    expect(nodeCard(container, "flow:end").getAttribute("data-run-state")).toBe(
      "idle",
    );
    const card = nodeCard(container, "flow:start");
    expect(card.className).not.toContain("border-destructive");
    expect(card.className).not.toContain("border-amber");
    expect(card.className).not.toContain("border-emerald");
  });

  it("paints completed green, failed red and untouched nodes idle", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        {
          type: "node-completed",
          nodeId: "n-a",
          step: 1,
          output: { ok: true },
        },
        { type: "node-started", nodeId: "n-b", step: 2 },
        { type: "node-failed", nodeId: "n-b", step: 2, error: "boom" },
        { type: "end" },
      ]),
    );

    const { container } = renderNodes([
      makeNode("n-a", "flow:start"),
      makeNode("n-b", "flow:end"),
      makeNode("n-c", "flow:wait"),
    ]);
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    await act(async () => {
      await bridgeStart!();
    });

    const completed = nodeCard(container, "flow:start");
    expect(completed.getAttribute("data-run-state")).toBe("completed");
    expect(completed.className).toContain("border-emerald");

    const failed = nodeCard(container, "flow:end");
    expect(failed.getAttribute("data-run-state")).toBe("failed");
    expect(failed.className).toContain("border-destructive");

    const idle = nodeCard(container, "flow:wait");
    expect(idle.getAttribute("data-run-state")).toBe("idle");
    expect(idle.className).not.toContain("border-emerald");
    expect(idle.className).not.toContain("border-destructive");
  });

  it("paints a node running while the stream is still open", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedStream.mockImplementation(async function* () {
      yield { type: "metadata", runId: "run-1", threadId: "t1" };
      yield { type: "node-started", nodeId: "n-c", step: 1 };
      await gate;
      yield { type: "end" };
    });

    const { container } = renderNodes([makeNode("n-c", "flow:wait")]);
    await waitFor(() => expect(bridgeStart).toBeTruthy());

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = bridgeStart!();
    });

    await waitFor(() => {
      const card = nodeCard(container, "flow:wait");
      expect(card.getAttribute("data-run-state")).toBe("running");
      expect(card.className).toContain("border-amber");
    });

    await act(async () => {
      release();
      await startPromise;
    });
  });

  it("keeps data-error while failed, with the destructive tint applied once", async () => {
    mockedStream.mockImplementation(() =>
      events([
        { type: "metadata", runId: "run-1", threadId: "t1" },
        { type: "node-started", nodeId: "n-a", step: 1 },
        {
          type: "node-completed",
          nodeId: "n-a",
          step: 1,
          output: { ok: true },
        },
        { type: "end" },
      ]),
    );

    const { container } = renderNodes([
      makeNode("n-a", "flow:start"),
      makeNode("n-b", "flow:end"),
    ]);
    await waitFor(() => expect(bridgeStart).toBeTruthy());
    await act(async () => {
      await bridgeStart!();
    });

    // Completed node gains a validation error -> data-error kept, destructive
    // tint wins over the completed green.
    await act(async () => {
      bridgeSetErrors!([{ type: "node", id: "n-a", message: "invalid" }]);
    });

    const withError = nodeCard(container, "flow:start");
    expect(withError.getAttribute("data-error")).toBe("true");
    expect(withError.getAttribute("data-run-state")).toBe("completed");
    expect(withError.className).toContain("border-destructive");
    expect(withError.className).not.toContain("border-emerald");

    // Failed node keeps its failed tint and never carries data-error.
    const failed = nodeCard(container, "flow:end");
    expect(failed.getAttribute("data-error")).toBeNull();
    expect(failed.getAttribute("data-run-state")).toBe("idle");
  });

  it("does not paint data-error when the validation error targets another node", async () => {
    const { container } = renderNodes([makeNode("n-a", "flow:start")]);
    await waitFor(() => expect(bridgeSetErrors).toBeTruthy());

    await act(async () => {
      bridgeSetErrors!([{ type: "node", id: "n-other", message: "invalid" }]);
    });

    expect(nodeCard(container, "flow:start").getAttribute("data-error")).toBe(
      null,
    );
  });
});
