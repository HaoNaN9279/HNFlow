import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";

import { WorkflowBreadcrumb } from "@/components/workspace/workflows/workflow-breadcrumb";

rs.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  cleanup();
});

function separators(container: HTMLElement) {
  return container.querySelectorAll('[data-slot="breadcrumb-separator"]');
}

describe("WorkflowBreadcrumb", () => {
  it("does not add a leading separator when the header already supplied one", () => {
    const { container } = render(
      <WorkflowBreadcrumb trail={[]} currentName="父流程A" />,
    );

    expect(separators(container)).toHaveLength(0);
  });

  it("adds exactly one separator between ancestor levels and the current one", () => {
    const { container } = render(
      <WorkflowBreadcrumb
        trail={[{ id: "wf-a", name: "父流程A" }]}
        currentName="子流程B"
      />,
    );

    expect(separators(container)).toHaveLength(1);
  });

  it("keeps one separator per boundary across multiple ancestors", () => {
    const { container } = render(
      <WorkflowBreadcrumb
        trail={[
          { id: "wf-a", name: "父流程A" },
          { id: "wf-b", name: "子流程B" },
        ]}
        currentName="孙流程C"
      />,
    );

    expect(separators(container)).toHaveLength(2);
  });
});
