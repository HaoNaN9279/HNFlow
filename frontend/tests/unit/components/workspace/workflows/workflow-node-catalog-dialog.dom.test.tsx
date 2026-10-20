import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkflowNodeCatalogDialog } from "@/components/workspace/workflows/workflow-node-catalog-dialog";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        nodeCatalog: {
          title: "Add node",
          hint: "Choose a node type",
          searchPlaceholder: "Search nodes...",
          empty: "No matching nodes",
        },
        categories: {
          flow: "Flow",
          data: "Data",
          tool: "Tools",
          ai: "AI",
          app: "App",
          human: "Human",
          subworkflow: "Subworkflow",
        },
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
});

function renderDialog(onSelect = rs.fn()) {
  render(
    <WorkflowNodeCatalogDialog
      open
      onOpenChange={() => undefined}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("WorkflowNodeCatalogDialog", () => {
  it("renders the catalog grouped by category", () => {
    renderDialog();

    expect(screen.getByTestId("workflow-node-catalog")).toBeTruthy();
    expect(screen.getByTestId("node-catalog-category-flow")).toBeTruthy();
    expect(screen.getByTestId("node-catalog-category-data")).toBeTruthy();
    expect(screen.getByTestId("node-catalog-category-tool")).toBeTruthy();
    expect(screen.getByTestId("node-catalog-category-ai")).toBeTruthy();
    expect(screen.getByTestId("node-catalog-category-app")).toBeTruthy();
    expect(screen.getByTestId("node-catalog-category-human")).toBeTruthy();
    expect(
      screen.getByTestId("node-catalog-category-subworkflow"),
    ).toBeTruthy();
  });

  it("filters entries by label, type, or description", () => {
    renderDialog();

    fireEvent.change(screen.getByTestId("node-catalog-search"), {
      target: { value: "bash" },
    });

    expect(screen.getByTestId("node-catalog-item-tool:bash")).toBeTruthy();
    expect(screen.queryByTestId("node-catalog-item-flow:start")).toBeNull();
    expect(screen.queryByTestId("node-catalog-category-flow")).toBeNull();
  });

  it("creates the selected node type", () => {
    const onSelect = renderDialog();

    fireEvent.click(screen.getByTestId("node-catalog-item-data:assign"));

    expect(onSelect).toHaveBeenCalledWith("data:assign");
  });

  it("shows an empty state when nothing matches", () => {
    renderDialog();

    fireEvent.change(screen.getByTestId("node-catalog-search"), {
      target: { value: "not-a-node" },
    });

    expect(screen.getByText("No matching nodes")).toBeTruthy();
  });
});
