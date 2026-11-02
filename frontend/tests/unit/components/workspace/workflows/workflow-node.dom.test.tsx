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
import type { WorkflowRecord } from "@/core/workflows/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        renameNodeHint: "Double-click to rename this node",
        properties: {
          deleteNode: "Delete node",
          paramsTitle: "Parameters",
          params: {
            invalidValue: "Invalid value",
            jsonHint: "Enter JSON",
            fields: {
              duration: "Duration (s)",
              value: "Value",
              taskPrompt: "Template prompt",
            },
          },
        },
      },
    },
  }),
}));

let bridgeSetErrors: ((errors: WorkflowValidationError[]) => void) | undefined;
let bridgeNodes: RFNode[] | undefined;

/** Hands the test the context functions that drive node/error state. */
function EditorBridge() {
  const { nodes, setErrors } = useWorkflowEditor();
  useEffect(() => {
    bridgeSetErrors = setErrors;
  }, [setErrors]);
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

beforeEach(() => {
  bridgeSetErrors = undefined;
  bridgeNodes = undefined;
  // The editor mirrors dirty canvases into sessionStorage; without clearing it
  // a previous test's draft seeds the next provider with the wrong nodes.
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

function renderNodes(nodes: RFNode[], selectedId?: string): RenderResult {
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
          <WorkflowNode
            key={node.id}
            {...nodeProps(node)}
            selected={node.id === selectedId}
          />
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
    node.data.workflow.params = { value: "hello", task: "do it" };
    const { container } = renderNodes([node]);
    const card = nodeCard(container, "data:assign");

    expect(
      card.querySelector<HTMLTextAreaElement>('[aria-label="Value"]')?.value,
    ).toContain('"hello"');
    expect(
      card.querySelector<HTMLTextAreaElement>('[aria-label="Template prompt"]')
        ?.value,
    ).toBe("do it");

    const handles = card.querySelectorAll<HTMLElement>(".react-flow__handle");
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.style.top).toBe("50%");
    }
  });

  it("renders fixed params and node actions without selection", async () => {
    const node = makeNode("n-unselected", "flow:wait");
    node.data.workflow.params = { duration: 3 };
    const { container } = renderNodes([node]);
    const card = nodeCard(container, "flow:wait");

    const duration = card.querySelector<HTMLInputElement>(
      '[aria-label="Duration (s)"]',
    );
    expect(duration?.value).toBe("3");
    expect(
      card.querySelector('[data-testid="workflow-node-delete"]'),
    ).toBeTruthy();
    expect(
      card.querySelector('[data-testid="workflow-breakpoint-toggle"]'),
    ).toBeNull();

    await waitFor(() =>
      expect(bridgeNodes?.some((item) => item.id === "n-unselected")).toBe(
        true,
      ),
    );
  });

  it("keeps input names on the left and output types on the left", () => {
    const node = makeNode("n-ports", "data:assign");
    node.data.workflow.inputs = [{ name: "in", type: "data" }];
    node.data.workflow.outputs = [{ name: "out", type: "data" }];
    const { container } = renderNodes([node]);
    const card = nodeCard(container, "data:assign");

    expect(
      card.querySelector('[data-testid="workflow-port-input-in"]')?.textContent,
    ).toBe("indata");
    expect(
      card.querySelector('[data-testid="workflow-port-output-out"]')
        ?.textContent,
    ).toBe("dataout");
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

describe("WorkflowNode validation state", () => {
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
