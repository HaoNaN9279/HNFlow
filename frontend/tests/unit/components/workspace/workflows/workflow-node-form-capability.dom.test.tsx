import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { WorkflowEditorProvider } from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowNodeForm } from "@/components/workspace/workflows/workflow-node-form";
import { previewWorkflowPrompt } from "@/core/workflows/api";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import type { WorkflowRecord } from "@/core/workflows/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        properties: {
          capabilityGroup: {
            title: "Capability group",
            groupLabel: "Group",
            groupPlaceholder: "Select a capability group...",
            noGroups: "No capability groups installed",
            mergeTitle: "Capability group merge",
            addInput: "Add input slot",
            removeInput: "Remove input slot",
            inputLabel: "Input slot",
            promptPreviewTitle: "Prompt preview",
            promptPreviewAgent: "LLM Agent",
            promptPreviewAgentPlaceholder: "Select an LLM Agent...",
            previewButton: "Preview prompt",
            previewing: "Building preview...",
            previewFailed: "Prompt preview failed",
            previewEmpty: "No prompt assembled",
            runtimeOmitted: "Static preview omits runtime blocks.",
          },
        },
      },
    },
  }),
}));

rs.mock("@/core/workflows/canvas/use-node-form-options", () => ({
  useAgentOptions: () => ({ data: [] }),
  useSkillOptions: () => ({ data: ["web-research", "code-review"] }),
  useWorkflowTemplateOptions: () => ({ data: [] }),
}));

rs.mock("@/core/workflows/api", () => ({
  previewWorkflowPrompt: rs.fn(),
}));

const mockedPreview = rs.mocked(previewWorkflowPrompt);

function makeNode(
  id: string,
  type: WorkflowNode["type"],
  workflow: Partial<WorkflowNode> = {},
): RFNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      workflow: {
        id,
        type,
        inputs: [],
        outputs: [],
        params: {},
        capability_groups: [],
        agent_name: null,
        ...workflow,
      },
    },
  };
}

function makeRecord(nodes: WorkflowNode[]): WorkflowRecord {
  return {
    id: "wf-1",
    user_id: "u1",
    name: "Sample",
    schema_version: 1,
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    metadata: {},
    definition: {
      id: "wf-1",
      name: "Sample",
      version: "0.1.0",
      metadata: {},
      nodes,
      edges: [],
    },
  };
}

function openSelect(name: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "ArrowDown",
  });
}

beforeEach(() => {
  mockedPreview.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("capability group forms", () => {
  it("selects a group and commits params.group", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeNode("g1", "ai:capability_group", {
          params: { group: "web-research" },
          outputs: [{ name: "groups", type: "array" }],
        })}
        readonly={false}
        onChange={onChange}
      />,
    );

    openSelect("Group");
    fireEvent.click(screen.getByRole("option", { name: "code-review" }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ group: "code-review" }),
      }),
    );
  });

  it("adds and removes merge input slots", () => {
    const onChange = rs.fn();
    const node = makeNode("m1", "ai:capability_merge", {
      inputs: [
        { name: "group_1", type: "array" },
        { name: "group_2", type: "array" },
      ],
      outputs: [{ name: "groups", type: "array" }],
    });
    render(
      <WorkflowNodeForm node={node} readonly={false} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add input slot" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputs: expect.arrayContaining([
          expect.objectContaining({ name: "group_3" }),
        ]),
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove input slot group_1" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputs: [expect.objectContaining({ name: "group_2" })],
      }),
    );
  });

  it("previews the prompt manually from the preview form", async () => {
    mockedPreview.mockResolvedValue({
      node_id: "p1",
      prompt: "FULL PROMPT",
      system_prompt: "SYSTEM",
      task_prompt: "TASK",
      capability_groups: ["web-research"],
      omitted_runtime_blocks: ["memory"],
    });

    const aiNode = makeNode("ai1", "ai:llm_agent", {
      params: { instruction: "Do it" },
    }).data.workflow;
    const previewNode = makeNode("p1", "ai:prompt_preview", {
      params: { agent_node: "ai1" },
      inputs: [{ name: "in", type: "data" }],
      outputs: [{ name: "prompt", type: "data" }],
    });

    render(
      <WorkflowEditorProvider record={makeRecord([aiNode])}>
        <WorkflowNodeForm
          node={previewNode}
          readonly={false}
          onChange={rs.fn()}
        />
      </WorkflowEditorProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));

    await waitFor(() => {
      expect(screen.getByText("FULL PROMPT")).toBeTruthy();
    });
    expect(mockedPreview).toHaveBeenCalledWith(
      "wf-1",
      expect.objectContaining({ node_id: "p1" }),
    );
    expect(
      screen.getByText("Static preview omits runtime blocks."),
    ).toBeTruthy();
  });
});
