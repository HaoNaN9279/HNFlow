import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { CapabilityGroupContents } from "@/app/workspace/capability-groups/page";
import type { CapabilityGroupDetail } from "@/core/capability-groups/types";

const revealMock = rs.hoisted(() => rs.fn());

rs.mock("@/core/capability-groups/hooks", () => ({
  useCapabilityGroups: rs.fn(),
  useCapabilityGroup: rs.fn(),
  revealCapabilityGroupFile: revealMock,
}));

rs.mock("sonner", () => ({
  toast: { success: rs.fn(), error: rs.fn() },
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      capabilityGroups: {
        loading: "Loading...",
        loadFailed: "Load failed",
        retry: "Retry",
        empty: "Empty",
        emptyHint: "Hint",
        loadingContents: "Loading contents...",
        loadContentsFailed: "Failed",
        noFiles: "No files",
        toolReferences: "Referenced tools",
        toolPermissions: "Permissions",
        reveal: "Reveal in file manager",
        revealFailed: "Reveal failed",
        revealed: "Revealed",
        title: "Capability groups",
        description: "Description",
        source: { public: "Built-in", user: "User" },
        categories: {
          rules: "Rules",
          agents: "Agents",
          skills: "Skills",
          tools: "Tools",
          references: "References",
          templates: "Templates",
          assets: "Assets",
          evals: "Evals",
          other: "Other",
        },
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  revealMock.mockReset();
});

const group: CapabilityGroupDetail = {
  guid: "a".repeat(32),
  name: "demo",
  version: "0.1.0",
  description: "Demo group",
  source: "public",
  permissions: [],
  extends: [],
  tools: ["builtin:read_file", "mcp:github:search"],
  tool_permissions: { "mcp:github:search": ["net"] },
  counts: { rules: 1, agents: 1, skills: 1, tools: 1 },
  categories: [
    {
      id: "rules",
      files: [
        {
          path: "rules/style.md",
          name: "style.md",
          category: "rules",
          is_markdown: true,
          summary: "Keep styles consistent",
          size: 10,
          modified_at: "",
        },
      ],
    },
    {
      id: "skills",
      files: [
        {
          path: "skills/child/SKILL.md",
          name: "SKILL.md",
          category: "skills",
          is_markdown: true,
          summary: "Child skill summary",
          size: 10,
          modified_at: "",
        },
      ],
    },
  ],
};

describe("CapabilityGroupContents", () => {
  it("renders category sections and one-line markdown summaries", () => {
    render(<CapabilityGroupContents group={group} />);

    expect(screen.getByText("Rules")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("Keep styles consistent")).toBeTruthy();
    expect(screen.getByText("Child skill summary")).toBeTruthy();
  });

  it("renders referenced tools and their permission overrides", () => {
    render(<CapabilityGroupContents group={group} />);

    expect(screen.getByText("Referenced tools")).toBeTruthy();
    expect(screen.getByText("builtin:read_file")).toBeTruthy();
    expect(screen.getByText("mcp:github:search")).toBeTruthy();
    expect(screen.getByText("Permissions: net")).toBeTruthy();
  });

  it("renders nested folders and arbitrary category names", () => {
    render(
      <CapabilityGroupContents
        group={{
          ...group,
          categories: [
            {
              id: "commands",
              files: [
                {
                  path: "commands/nested/build.md",
                  name: "build.md",
                  category: "commands",
                  is_markdown: true,
                  summary: "Build the project",
                  size: 10,
                  modified_at: "",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("commands")).toBeTruthy();
    expect(
      screen.getByTestId("capability-group-folder").dataset.folderPath,
    ).toBe("nested");
    expect(screen.getByText("Build the project")).toBeTruthy();
  });

  it("reveals a file through the capability-group API", async () => {
    revealMock.mockResolvedValue(undefined);
    render(<CapabilityGroupContents group={group} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reveal in file manager style.md",
      }),
    );

    await waitFor(() =>
      expect(revealMock).toHaveBeenCalledWith(
        group.guid,
        "rules/style.md",
        group.version,
      ),
    );
  });
});
