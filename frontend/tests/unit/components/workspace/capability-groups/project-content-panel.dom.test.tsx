import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProjectContentPanel } from "@/components/workspace/capability-groups/project-content-panel";
import type { ProjectContentRecord } from "@/core/project-content/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      projectContent: {
        title: "Project content",
        description: "Project-owned content.",
        contentRoot: "Content root",
        contentRootMissing: "Content root is not configured",
        noContentRoot: "No content directory",
        empty: "No extra content",
        instructions: "Project instructions",
        rules: "Project rules",
        skills: "Project skills",
        tools: "Project tools",
        skillShadow: "Skill shadowing",
        pythonTools: "Python tools",
        allow: "allowed",
        deny: "denied",
        reveal: "Reveal in file manager",
        selectProject: "Project",
        selectProjectPlaceholder: "No project selected (groups only)",
        loadFailed: "Failed to load project content",
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
});

const content: ProjectContentRecord = {
  project_id: "proj-1",
  root_path: "D:/work/demo",
  root: "D:/work/demo",
  content_root: "D:/work/demo/.hnflow/content",
  instructions: [
    { path: "AGENTS.md", layer: "project", source: "project:AGENTS.md" },
  ],
  rules: [{ path: "rules/10-api.md", source: "project:rules/10-api.md" }],
  skills: [
    {
      name: "deploy",
      description: "Deploy the service.",
      path: "skills/deploy/SKILL.md",
      source: "project:skills/deploy/SKILL.md",
    },
  ],
  tools: [
    {
      ref: "tool:aaa@v0.1.0",
      provider: "python",
      name: "proj-tool",
      version: "0.1.0",
      path: "",
      error: "",
    },
  ],
  skill_shadow: "deny",
  allow_python_tools: false,
  warnings: ["instruction file missing: docs/EXTRA.md"],
  exists: true,
  fingerprint: "fp",
  snapshot: [{ path: "AGENTS.md", sha256: "abc" }],
};

describe("ProjectContentPanel", () => {
  it("renders instructions, rules, skills and tools", () => {
    render(<ProjectContentPanel content={content} />);

    expect(screen.getByTestId("project-content")).toBeTruthy();
    expect(screen.getByText("Project instructions")).toBeTruthy();
    expect(screen.getByText("AGENTS.md")).toBeTruthy();
    expect(screen.getByText("rules/10-api.md")).toBeTruthy();
    expect(screen.getByText("deploy")).toBeTruthy();
    expect(screen.getByText("tool:aaa@v0.1.0")).toBeTruthy();
  });

  it("surfaces trust switches and warnings", () => {
    render(<ProjectContentPanel content={content} />);

    expect(screen.getByText("Skill shadowing: denied")).toBeTruthy();
    expect(screen.getByText("Python tools: denied")).toBeTruthy();
    expect(
      screen.getByText("instruction file missing: docs/EXTRA.md"),
    ).toBeTruthy();
  });

  it("reveals a project file through the callback", () => {
    const onReveal = rs.fn();
    render(<ProjectContentPanel content={content} onReveal={onReveal} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Reveal in file manager AGENTS.md" }),
    );

    expect(onReveal).toHaveBeenCalledWith("AGENTS.md");
  });

  it("renders the empty state when the project has no content", () => {
    render(
      <ProjectContentPanel
        content={{
          ...content,
          instructions: [],
          rules: [],
          skills: [],
          tools: [],
          warnings: [],
          content_root: null,
          exists: false,
        }}
      />,
    );

    expect(screen.getByText("No extra content")).toBeTruthy();
    expect(screen.getByText("Content root is not configured")).toBeTruthy();
  });
});
