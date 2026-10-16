import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkflowPropertiesPanel } from "@/components/workspace/workflows/workflow-properties-panel";
import type { RFNode } from "@/core/workflows/canvas/mapping";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        properties: {
          title: "Properties",
          paramsTitle: "Parameters",
          portsTitle: "Ports",
          inputs: "Inputs",
          outputs: "Outputs",
          deleteNode: "Delete node",
          breakpointLabel: "Pause before this node (breakpoint)",
          breakpointHint:
            "Suspends the run as a human task before the node executes",
          paramKey: "Param key",
          paramValue: "Param value",
          addParam: "Add param",
          removeParam: "Remove param",
          nodeIdLabel: "Node ID",
          nodeTypeLabel: "Node type",
          noSelection: "No node selected",
        },
      },
    },
  }),
}));

afterEach(() => {
  rs.restoreAllMocks();
  cleanup();
});

function makeNode(overrides: Partial<RFNode> = {}): RFNode {
  return {
    id: "n_1",
    type: "flow:if",
    position: { x: 0, y: 0 },
    data: {
      workflow: {
        id: "n_1",
        type: "flow:if",
        inputs: [{ name: "in", type: "data", required: true }],
        outputs: [
          { name: "true", type: "bool", required: true },
          { name: "false", type: "bool", required: true },
        ],
        params: { threshold: 10, label: "check" },
        capability_groups: [],
        agent_name: null,
      },
    },
    ...overrides,
  };
}

describe("WorkflowPropertiesPanel", () => {
  it("shows the no-selection placeholder when no node is selected", () => {
    render(
      <WorkflowPropertiesPanel
        node={null}
        onUpdateNodeParams={rs.fn()}
        onDeleteNode={rs.fn()}
      />,
    );
    expect(screen.getByText("No node selected")).toBeTruthy();
  });

  it("renders the selected node's params as key/value rows", () => {
    render(
      <WorkflowPropertiesPanel
        node={makeNode()}
        onUpdateNodeParams={rs.fn()}
        onDeleteNode={rs.fn()}
      />,
    );

    expect(screen.getByDisplayValue("threshold")).toBeTruthy();
    expect(screen.getByDisplayValue("10")).toBeTruthy();
    expect(screen.getByDisplayValue("label")).toBeTruthy();
    expect(screen.getByDisplayValue('"check"')).toBeTruthy();
  });

  it("writes an edited param value back through the callback on blur", () => {
    const onUpdateNodeParams = rs.fn();
    render(
      <WorkflowPropertiesPanel
        node={makeNode()}
        onUpdateNodeParams={onUpdateNodeParams}
        onDeleteNode={rs.fn()}
      />,
    );

    const valueInput = screen.getByLabelText("Param value 1");
    fireEvent.change(valueInput, { target: { value: "20" } });
    fireEvent.blur(valueInput);

    expect(onUpdateNodeParams).toHaveBeenCalledTimes(1);
    expect(onUpdateNodeParams).toHaveBeenCalledWith("n_1", {
      threshold: 20,
      label: "check",
    });
  });

  it("deletes a param row through the callback", () => {
    const onUpdateNodeParams = rs.fn();
    render(
      <WorkflowPropertiesPanel
        node={makeNode()}
        onUpdateNodeParams={onUpdateNodeParams}
        onDeleteNode={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove param label"));

    expect(onUpdateNodeParams).toHaveBeenCalledTimes(1);
    expect(onUpdateNodeParams).toHaveBeenCalledWith("n_1", {
      threshold: 10,
    });
  });

  it("restores an invalid JSON value and does not write back", () => {
    const onUpdateNodeParams = rs.fn();
    render(
      <WorkflowPropertiesPanel
        node={makeNode()}
        onUpdateNodeParams={onUpdateNodeParams}
        onDeleteNode={rs.fn()}
      />,
    );

    const valueInput = screen.getByLabelText("Param value 1");
    fireEvent.change(valueInput, { target: { value: "not-json" } });
    fireEvent.blur(valueInput);

    expect(onUpdateNodeParams).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("10")).toBeTruthy();
  });

  it("calls the delete-node callback for the selected node", () => {
    const onDeleteNode = rs.fn();
    render(
      <WorkflowPropertiesPanel
        node={makeNode()}
        onUpdateNodeParams={rs.fn()}
        onDeleteNode={onDeleteNode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete node" }));

    expect(onDeleteNode).toHaveBeenCalledWith("n_1");
  });

  it("sets params.breakpoint when the breakpoint toggle is checked (§25)", () => {
    const onUpdateNodeParams = rs.fn();
    render(
      <WorkflowPropertiesPanel
        node={makeNode()}
        onUpdateNodeParams={onUpdateNodeParams}
        onDeleteNode={rs.fn()}
      />,
    );

    fireEvent.click(
      screen.getByLabelText("Pause before this node (breakpoint)"),
    );

    expect(onUpdateNodeParams).toHaveBeenCalledWith("n_1", {
      threshold: 10,
      label: "check",
      breakpoint: true,
    });
  });

  it("removes the breakpoint key when the toggle is unchecked (§25)", () => {
    const onUpdateNodeParams = rs.fn();
    const node = makeNode();
    node.data.workflow.params = { threshold: 10, breakpoint: true };
    render(
      <WorkflowPropertiesPanel
        node={node}
        onUpdateNodeParams={onUpdateNodeParams}
        onDeleteNode={rs.fn()}
      />,
    );

    fireEvent.click(
      screen.getByLabelText("Pause before this node (breakpoint)"),
    );

    // Cleared rather than written as `false`, so the saved definition carries
    // no vestigial key.
    expect(onUpdateNodeParams).toHaveBeenCalledWith("n_1", {
      threshold: 10,
    });
  });

  it("renders the breakpoint toggle as checked for a breakpoint node (§25)", () => {
    const node = makeNode();
    node.data.workflow.params = { breakpoint: true };
    render(
      <WorkflowPropertiesPanel
        node={node}
        onUpdateNodeParams={rs.fn()}
        onDeleteNode={rs.fn()}
      />,
    );

    const toggle = screen.getByLabelText<HTMLInputElement>(
      "Pause before this node (breakpoint)",
    );
    expect(toggle.checked).toBe(true);
  });
});
