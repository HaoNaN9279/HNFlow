import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AiPromptComposition } from "@/components/workspace/workflows/workflow-ai-prompt-composition";
import type { RFNode } from "@/core/workflows/canvas/mapping";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        properties: {
          ai: {
            promptComposition: {
              title: "Prompt composition",
              hint: "Built from the current node connections",
              loading: "Loading prompt...",
              loadFailed: "Prompt preview failed",
              retry: "Retry",
              tokens: "~{count} tokens",
              sections: { system: "System", task: "User turn" },
              states: {
                runtime: "Runtime",
                dropped: "Dropped",
                truncated: "Truncated",
              },
              sources: {
                memory: "Memory",
                retrieval: "Knowledge retrieval",
                identity: "Identity",
                capability: "Capability",
                capability_rules: "Capability rules",
                capability_skills: "Capability skills",
                examples: "Examples",
                context: "Context",
                schema: "Output schema",
                task: "Task",
                template_prompt: "Template prompt",
              },
              runtimeUnavailable: "Runtime content is not available",
            },
          },
        },
      },
    },
  }),
}));

rs.mock("@/components/workspace/workflows/workflow-editor-context", () => ({
  useWorkflowEditor: () => ({
    workflowId: "wf-1",
    currentDefinition: () => ({
      id: "wf-1",
      name: "Workflow",
      version: "0.1.0",
      nodes: [],
      edges: [],
      metadata: {},
    }),
  }),
}));

rs.mock("@/core/workflows/api", () => ({
  previewWorkflowPrompt: rs.fn().mockResolvedValue({
    node_id: "ai",
    prompt: "Identity\n\nTask\n\nUser",
    system_prompt: "Identity",
    task_prompt: "Task\n\nUser",
    capability_groups: [],
    omitted_runtime_blocks: [],
    components: [
      {
        key: "identity",
        section: "system",
        source: "agent:lead (default)",
        summary: "Default lead agent",
        content: "Identity\nbody",
        estimated_tokens: 4,
        state: "active",
        editable: false,
      },
      {
        key: "capability_rule:alpha@0.1.0:rules/a.md",
        section: "system",
        source: "capability_group:alpha@0.1.0/rules/a.md",
        summary: "alpha@0.1.0 · rules/a.md · Rule",
        content: "RULE BODY",
        estimated_tokens: 2,
        state: "active",
        editable: false,
        label: "Rule: alpha / rules/a.md",
      },
      {
        key: "capability_skill:alpha@0.1.0:profile",
        section: "system",
        source: "capability_group:alpha@0.1.0/skills/profile/SKILL.md",
        summary: "profile: Build a profile",
        content: "- profile: Build a profile",
        estimated_tokens: 3,
        state: "active",
        editable: false,
        label: "Skill: alpha / profile",
      },
      {
        key: "task",
        section: "task",
        source: "params.instruction",
        summary: "Instruction: Do it",
        content: "Do it",
        estimated_tokens: 2,
        state: "active",
        editable: false,
      },
      {
        key: "template_prompt",
        section: "task",
        source: "inputs.template_prompt",
        summary: "Port: template_prompt \u2190 prompt.out",
        content: "",
        estimated_tokens: 0,
        state: "runtime",
        editable: false,
      },
    ],
  }),
}));

const node: RFNode = {
  id: "ai",
  type: "ai:llm_agent",
  position: { x: 0, y: 0 },
  data: {
    workflow: {
      id: "ai",
      type: "ai:llm_agent",
      inputs: [],
      outputs: [],
      params: { instruction: "Do it" },
      capability_groups: [],
      agent_name: null,
    },
  },
};

afterEach(cleanup);

describe("AiPromptComposition", () => {
  it("lists capability rules and opens a read-only content dialog", async () => {
    render(<AiPromptComposition node={node} readonly={false} />);

    const source = await screen.findByTestId(
      "prompt-source-capability_rule:alpha@0.1.0:rules/a.md",
    );
    expect(screen.getByText("Rule: alpha / rules/a.md")).toBeTruthy();
    expect(
      screen.getByTestId("prompt-source-capability_skill:alpha@0.1.0:profile"),
    ).toBeTruthy();

    fireEvent.click(source);

    const content = await screen.findByTestId("prompt-source-content");
    expect(content.textContent).toContain("RULE BODY");
    expect(
      within(screen.getByRole("dialog")).queryByRole("textbox"),
    ).toBeNull();
  });

  it("shows runtime prompt inputs without an editable textarea", async () => {
    render(<AiPromptComposition node={node} readonly={false} />);

    const source = await screen.findByTestId("prompt-source-template_prompt");
    expect(screen.queryByTestId("ai-user-prompt-card")).toBeNull();

    fireEvent.click(source);

    await waitFor(() => {
      expect(screen.getByText("Runtime content is not available")).toBeTruthy();
    });
    expect(
      within(screen.getByRole("dialog")).queryByRole("textbox"),
    ).toBeNull();
  });
});
