import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";

import { WorkflowErrorList } from "@/components/workspace/workflows/workflow-error-list";
import type { WorkflowValidationError } from "@/core/workflows/errors";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        errors: {
          validationPrefix: "Validation failed: ",
        },
      },
    },
  }),
}));

afterEach(() => {
  rs.restoreAllMocks();
  cleanup();
});

describe("WorkflowErrorList", () => {
  it("renders nothing for an empty error list", () => {
    const { container } = render(<WorkflowErrorList errors={[]} />);
    expect(container.childNodes).toHaveLength(0);
  });

  it("renders every validation message with its node/edge id", () => {
    const errors: WorkflowValidationError[] = [
      { type: "node", id: "n_1", message: "node n_1 has a problem" },
      { type: "edge", id: "3", message: "edge[3] connects incompatible ports" },
      { type: "unknown", message: "unparseable detail" },
    ];
    render(<WorkflowErrorList errors={errors} />);

    expect(screen.getByText(/Validation failed/)).toBeTruthy();
    expect(screen.getByText("node n_1 has a problem")).toBeTruthy();
    expect(
      screen.getByText("edge[3] connects incompatible ports"),
    ).toBeTruthy();
    expect(screen.getByText("unparseable detail")).toBeTruthy();

    const nodeItem = screen.getByText("node n_1 has a problem");
    expect(nodeItem.getAttribute("data-error-id")).toBe("n_1");
    const edgeItem = screen.getByText("edge[3] connects incompatible ports");
    expect(edgeItem.getAttribute("data-error-id")).toBe("3");
    const unknownItem = screen.getByText("unparseable detail");
    expect(unknownItem.hasAttribute("data-error-id")).toBe(false);
  });
});
