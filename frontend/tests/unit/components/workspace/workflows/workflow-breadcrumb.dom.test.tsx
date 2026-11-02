import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";

import { WorkflowBreadcrumb } from "@/components/workspace/workflows/workflow-breadcrumb";
import type { WorkflowFolder } from "@/core/workflows/workflow-folders";

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

  it("renders the folder hierarchy before subworkflow ancestors", () => {
    const folders: WorkflowFolder[] = [
      {
        id: "folder-a",
        user_id: "u",
        name: "Project A",
        parent_id: null,
        order_index: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "folder-b",
        user_id: "u",
        name: "Nested",
        parent_id: "folder-a",
        order_index: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const { container } = render(
      <WorkflowBreadcrumb
        folderPath={folders}
        trail={[{ id: "wf-a", name: "Parent flow" }]}
        currentName="Child flow"
      />,
    );

    const links = [...container.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toEqual([
      "/workspace/workflows?folder=folder-a",
      "/workspace/workflows?folder=folder-b",
      "/workspace/workflows/wf-a",
    ]);
    expect(screen.getByText("Project A")).toBeTruthy();
    expect(screen.getByText("Nested")).toBeTruthy();
    expect(separators(container)).toHaveLength(3);
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
