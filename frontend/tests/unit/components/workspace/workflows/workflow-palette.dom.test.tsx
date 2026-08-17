import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WORKFLOW_NODE_DRAG_DATA_TYPE } from "@/components/workspace/workflows/workflow-dnd";
import { WorkflowPalette } from "@/components/workspace/workflows/workflow-palette";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        canvas: {
          paletteTitle: "Palette",
          searchPlaceholder: "Search nodes...",
        },
        categories: {
          flow: "Flow",
          data: "Data",
          tool: "Tools",
          ai: "AI",
          human: "Human",
          subworkflow: "Subworkflow",
        },
      },
    },
  }),
}));

afterEach(() => {
  rs.restoreAllMocks();
  cleanup();
});

describe("WorkflowPalette", () => {
  it("renders catalog entries grouped by category", () => {
    render(<WorkflowPalette />);

    // Category groups exist (headers come from the i18n dictionary; the
    // subworkflow *entry* label collides with its category header, so assert
    // on the group testids instead of bare text).
    expect(screen.getByTestId("palette-category-flow")).toBeTruthy();
    expect(screen.getByTestId("palette-category-data")).toBeTruthy();
    expect(screen.getByTestId("palette-category-tool")).toBeTruthy();
    expect(screen.getByTestId("palette-category-ai")).toBeTruthy();
    expect(screen.getByTestId("palette-category-human")).toBeTruthy();
    expect(screen.getByTestId("palette-category-subworkflow")).toBeTruthy();

    // Every catalog node appears under its category.
    expect(screen.getByTestId("palette-item-flow:start")).toBeTruthy();
    expect(screen.getByTestId("palette-item-tool:bash")).toBeTruthy();
    expect(screen.getByTestId("palette-item-ai:llm_agent")).toBeTruthy();
  });

  it("sets the node type on the drag data when an item is dragged", () => {
    render(<WorkflowPalette />);

    const item = screen.getByTestId("palette-item-flow:if");
    const dataTransfer = {
      setData: rs.fn(),
      getData: rs.fn(),
      effectAllowed: "",
    };

    fireEvent.dragStart(item, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith(
      WORKFLOW_NODE_DRAG_DATA_TYPE,
      "flow:if",
    );
  });

  it("filters entries by the search query", () => {
    render(<WorkflowPalette />);

    fireEvent.change(screen.getByLabelText("Search nodes..."), {
      target: { value: "bash" },
    });

    expect(screen.getByTestId("palette-item-tool:bash")).toBeTruthy();
    expect(screen.queryByTestId("palette-item-flow:start")).toBeNull();
  });
});
