import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WorkflowNodeForm } from "@/components/workspace/workflows/workflow-node-form";
import { WorkflowPropertiesPanel } from "@/components/workspace/workflows/workflow-properties-panel";
import { checkAgentName } from "@/core/agents/api";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import type { WorkflowNode } from "@/core/workflows/canvas/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        properties: {
          title: "Properties",
          paramsTitle: "Parameters",
          portsTitle: "Ports",
          inputs: "Inputs",
          outputs: "Outputs",
          deleteNode: "Delete node",
          paramKey: "Parameter name",
          paramValue: "Parameter value",
          addParam: "Add param",
          removeParam: "Remove param",
          nodeIdLabel: "Node ID",
          nodeTypeLabel: "Node type",
          noSelection: "No node selected",
          ai: {
            title: "AI Agent",
            instructionLabel: "Instruction",
            instructionPlaceholder: "Task template...",
            agentLabel: "Agent",
            agentNoneOption: "Lead agent (default)",
            agentHint: "^[A-Za-z0-9-]+$",
            capabilityGroupsLabel: "Capability groups",
            capabilityGroupsPlaceholder: "Select skills...",
          },
          subworkflow: {
            title: "Subworkflow",
            templateLabel: "Workflow template",
            templatePlaceholder: "Select a workflow template...",
            modeLabel: "Mode",
            versionLabel: "Version",
            noTemplates: "No other workflows available",
          },
          validation: {
            instructionRequired: "Instruction is required",
            templateRequired: "Workflow template is required",
            invalidAgentName: "Agent name must match ^[A-Za-z0-9-]+$",
            agentNotFoundWarning: "Agent does not exist yet",
          },
        },
      },
    },
  }),
}));

rs.mock("@/core/agents/api", () => ({
  checkAgentName: rs.fn(),
}));

let agentOptions: { name: string }[] = [{ name: "researcher" }];
let skillOptions: string[] = ["web-research", "code-review"];
let templateOptions: { id: string; name: string; version: string }[] = [
  { id: "wf-1", name: "Alpha", version: "0.1.0" },
  { id: "wf-2", name: "Beta", version: "0.2.0" },
];

rs.mock("@/core/workflows/canvas/use-node-form-options", () => ({
  useAgentOptions: () => ({ data: agentOptions }),
  useSkillOptions: () => ({ data: skillOptions }),
  useWorkflowTemplateOptions: () => ({ data: templateOptions }),
}));

const mockedCheckAgentName = rs.mocked(checkAgentName);

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

function makeAINode(workflow: Partial<WorkflowNode> = {}): RFNode {
  return makeNode("n_1", "ai:llm_agent", {
    params: { instruction: "Do the thing" },
    agent_name: "researcher",
    capability_groups: ["web-research"],
    ...workflow,
  });
}

function makeSubworkflowNode(workflow: Partial<WorkflowNode> = {}): RFNode {
  return makeNode("n_2", "nested:subworkflow", {
    params: {
      subworkflow: {
        type: "template",
        mode: "compile",
        template_id: "wf-1",
        version: "0.1.0",
      },
    },
    ...workflow,
  });
}

function openSelect(name: string) {
  const trigger = screen.getByRole("combobox", { name });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

beforeEach(() => {
  agentOptions = [{ name: "researcher" }];
  skillOptions = ["web-research", "code-review"];
  templateOptions = [
    { id: "wf-1", name: "Alpha", version: "0.1.0" },
    { id: "wf-2", name: "Beta", version: "0.2.0" },
  ];
  mockedCheckAgentName.mockReset();
  mockedCheckAgentName.mockResolvedValue({
    available: true,
    name: "my-agent",
  });
});

afterEach(() => {
  rs.restoreAllMocks();
  cleanup();
});

describe("WorkflowNodeForm — ai:llm_agent", () => {
  it("renders the instruction value, selected agent and chosen skills", () => {
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByDisplayValue("Do the thing")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Agent" }).textContent,
    ).toContain("researcher");
    expect(
      screen.getByRole("button", { name: "Remove skill web-research" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Add skill code-review" }),
    ).toBeTruthy();
  });

  it("commits an edited instruction on blur with top-level fields preserved", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    const textarea = screen.getByLabelText("Instruction");
    fireEvent.change(textarea, { target: { value: "New instruction" } });
    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_name: "researcher",
        capability_groups: ["web-research"],
        params: expect.objectContaining({ instruction: "New instruction" }),
      }),
    );
  });

  it("shows the required error for an empty instruction", () => {
    render(
      <WorkflowNodeForm
        node={makeAINode({ params: { instruction: "" } })}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByText("Instruction is required")).toBeTruthy();
  });

  it("shows the invalid-agent-name error for a malformed name", () => {
    render(
      <WorkflowNodeForm
        node={makeAINode({ agent_name: "bad name!" })}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(
      screen.getByText("Agent name must match ^[A-Za-z0-9-]+$"),
    ).toBeTruthy();
  });

  it("commits a custom agent typed in the free input and warns when it does not exist", async () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode({ agent_name: "" })}
        readonly={false}
        onChange={onChange}
      />,
    );

    openSelect("Agent");
    fireEvent.click(screen.getByRole("option", { name: "Custom agent..." }));

    const input = screen.getByLabelText("Custom agent name");
    fireEvent.change(input, { target: { value: "my-agent" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ agent_name: "my-agent" }),
    );
    expect(mockedCheckAgentName).toHaveBeenCalledWith("my-agent");

    await waitFor(() => {
      expect(screen.getByText("Agent does not exist yet")).toBeTruthy();
    });
  });

  it("commits agent_name null when the lead-agent (None) option is chosen", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    openSelect("Agent");
    fireEvent.click(screen.getByRole("option", { name: "Lead agent (default)" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ agent_name: null }),
    );
  });

  it("adds a skill through the checkbox list", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Add skill code-review" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        capability_groups: ["web-research", "code-review"],
      }),
    );
  });

  it("accumulates consecutive skill picks and reflects them in the UI", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode({ capability_groups: [] })}
        readonly={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Add skill web-research" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Add skill code-review" }),
    );

    // The second pick builds on the first, not on the stale initial value.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capability_groups: ["web-research", "code-review"],
      }),
    );

    // UI follows the draft: both checkboxes checked, both badges shown.
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Add skill web-research",
      }).checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Add skill code-review",
      }).checked,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Remove skill web-research" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove skill code-review" }),
    ).toBeTruthy();
  });

  it("unchecks one skill and keeps the other", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode({
          capability_groups: ["web-research", "code-review"],
        })}
        readonly={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove skill web-research" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ capability_groups: ["code-review"] }),
    );
    expect(
      screen.queryByRole("button", { name: "Remove skill web-research" }),
    ).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Add skill web-research",
      }).checked,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Add skill code-review",
      }).checked,
    ).toBe(true);
  });

  it("removes a chosen skill through its badge button", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove skill web-research" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ capability_groups: [] }),
    );
  });

  it("shows the no-skills hint when the skill list is empty", () => {
    skillOptions = [];
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByText("No skills available")).toBeTruthy();
  });
});

describe("WorkflowNodeForm — nested:subworkflow", () => {
  it("renders template options as name (version) and keeps the current spec", () => {
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode()}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    openSelect("Workflow template");
    expect(
      screen.getByRole("option", { name: "Alpha (0.1.0)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Beta (0.2.0)" }),
    ).toBeTruthy();
    expect(screen.getByText("Version")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
  });

  it("commits the selected template into params.subworkflow", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    openSelect("Workflow template");
    fireEvent.click(screen.getByRole("option", { name: "Beta (0.2.0)" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          subworkflow: {
            type: "template",
            mode: "compile",
            template_id: "wf-2",
            version: "0.2.0",
          },
        }),
      }),
    );
  });

  it("updates the select display and version row after choosing a template", () => {
    const onChange = rs.fn();
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    // Starts from the stored spec.
    expect(
      screen.getByRole("combobox", { name: "Workflow template" }).textContent,
    ).toContain("Alpha (0.1.0)");
    expect(screen.getByText("0.1.0")).toBeTruthy();

    openSelect("Workflow template");
    fireEvent.click(screen.getByRole("option", { name: "Beta (0.2.0)" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          subworkflow: {
            type: "template",
            mode: "compile",
            template_id: "wf-2",
            version: "0.2.0",
          },
        }),
      }),
    );

    // UI follows the draft without a reload.
    expect(
      screen.getByRole("combobox", { name: "Workflow template" }).textContent,
    ).toContain("Beta (0.2.0)");
    expect(screen.getByText("0.2.0")).toBeTruthy();
  });

  it("shows the required error when no template is selected", () => {
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode({ params: {} })}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByText("Workflow template is required")).toBeTruthy();
  });

  it("shows the no-templates hint when no other workflows exist", () => {
    templateOptions = [];
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode({ params: {} })}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByText("No other workflows available")).toBeTruthy();
  });
});

describe("WorkflowNodeForm — fallback", () => {
  it("renders nothing for a non-typed node so the generic editor stays", () => {
    const { container } = render(
      <WorkflowNodeForm
        node={makeNode("n_3", "flow:if")}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});

describe("WorkflowNodeForm — properties panel integration", () => {
  it("keeps typed instruction out of the generic key/value draft (R4)", () => {
    const onUpdateNode = rs.fn();
    const onUpdateNodeParams = rs.fn();
    render(
      <WorkflowPropertiesPanel
        node={makeAINode({
          params: { instruction: "Do the thing", extra: 1 },
        })}
        onUpdateNodeParams={onUpdateNodeParams}
        onUpdateNode={onUpdateNode}
        onDeleteNode={rs.fn()}
      />,
    );

    // Typed form zone renders the instruction textarea...
    expect(screen.getByDisplayValue("Do the thing")).toBeTruthy();

    // ...and the generic draft keeps only the non-typed key.
    expect(screen.getByDisplayValue("extra")).toBeTruthy();
    expect(screen.getByDisplayValue("1")).toBeTruthy();
    expect(screen.queryByDisplayValue("instruction")).toBeNull();
    expect(screen.queryByLabelText("Parameter name 2")).toBeNull();
  });
});
