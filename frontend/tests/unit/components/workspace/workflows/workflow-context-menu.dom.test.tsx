import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkflowContextMenu } from "@/components/workspace/workflows/workflow-context-menu";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        contextMenu: {
          copy: "Copy",
          cut: "Cut",
          paste: "Paste",
          subworkflowGlobal: "Follow template",
          subworkflowLocal: "Save locally",
        },
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
});

function renderMenu(
  options: {
    nodeId?: string | null;
    canPaste?: boolean;
    subworkflowMode?: "global" | "local" | null;
  } = {},
) {
  const onCopy = rs.fn();
  const onCut = rs.fn();
  const onPaste = rs.fn();
  const onSetSubworkflowMode = rs.fn();
  const onClose = rs.fn();
  const nodeId = "nodeId" in options ? options.nodeId! : "n_1";
  render(
    <WorkflowContextMenu
      state={{ x: 100, y: 120, nodeId }}
      canPaste={options.canPaste ?? true}
      subworkflowMode={options.subworkflowMode ?? null}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
      onSetSubworkflowMode={onSetSubworkflowMode}
      onClose={onClose}
    />,
  );
  return { onCopy, onCut, onPaste, onSetSubworkflowMode, onClose };
}

describe("WorkflowContextMenu", () => {
  it("offers copy, cut, and paste on a node", () => {
    const handlers = renderMenu();

    fireEvent.click(screen.getByTestId("context-menu-copy"));
    fireEvent.click(screen.getByTestId("context-menu-cut"));
    fireEvent.click(screen.getByTestId("context-menu-paste"));

    expect(handlers.onCopy).toHaveBeenCalledTimes(1);
    expect(handlers.onCut).toHaveBeenCalledTimes(1);
    expect(handlers.onPaste).toHaveBeenCalledTimes(1);
  });

  it("offers only paste on empty canvas space", () => {
    renderMenu({ nodeId: null });

    expect(screen.queryByTestId("context-menu-copy")).toBeNull();
    expect(screen.queryByTestId("context-menu-cut")).toBeNull();
    expect(screen.getByTestId("context-menu-paste")).toBeTruthy();
  });

  it("disables paste until something has been copied", () => {
    renderMenu({ nodeId: null, canPaste: false });

    expect(
      screen.getByTestId<HTMLButtonElement>("context-menu-paste").disabled,
    ).toBe(true);
  });

  it("switches subworkflow save modes", () => {
    const handlers = renderMenu({ subworkflowMode: "global" });

    fireEvent.click(screen.getByTestId("context-menu-subworkflow-local"));
    fireEvent.click(screen.getByTestId("context-menu-subworkflow-global"));

    expect(handlers.onSetSubworkflowMode).toHaveBeenNthCalledWith(1, "local");
    expect(handlers.onSetSubworkflowMode).toHaveBeenNthCalledWith(2, "global");
  });

  it("closes on Escape", () => {
    const handlers = renderMenu();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
