import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { WorkflowNodeForm } from "@/components/workspace/workflows/workflow-node-form";
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
          params: {
            invalidValue: "Invalid value",
            jsonHint: "Enter JSON",
            fields: { breakpoint: "Breakpoint" },
          },
          ai: {
            title: "AI Agent",
            agentLabel: "Agent",
            agentNoneOption: "Lead agent (default)",
            agentHint: "^[A-Za-z0-9-]+$",
            modelProfileLabel: "Model profile",
            modelProfileNoneOption: "Default / inherit",
            modelProfileHint: "Resolved at runtime",
            modelProfileMissing: "Selected profile is unavailable",
            capabilityGroupsLabel: "Capability groups",
            capabilityGroupsPlaceholder: "Select skills...",
            continuePromptLabel: "Continue prompt",
            continuePromptHint:
              "Wire into continue_prompt on the canvas to resume",
            configTitle: "Node configuration",
            promptComposition: {
              title: "Prompt composition",
              hint: "Built from the current node connections",
              loading: "Building prompt preview...",
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
          subworkflow: {
            title: "Subworkflow",
            templateLabel: "Workflow template",
            templatePlaceholder: "Select a workflow template...",
            modeLabel: "Mode",
            versionLabel: "Version",
            noTemplates: "No other workflows available",
            mappingTitle: "Port mapping",
            inputMappingLabel: "Input mapping",
            outputMappingLabel: "Output mapping",
            unmappedPlaceholder: "Not mapped",
            openButton: "Open subworkflow",
            saveModeLabel: "Save mode",
            saveModeGlobal: "Follow template",
            saveModeLocal: "Local copy",
            localSnapshotLabel: "Local snapshot of",
          },
          validation: {
            templateRequired: "Workflow template is required",
            invalidAgentName: "Agent name must match ^[A-Za-z0-9-]+$",
            agentNotFoundWarning: "Agent does not exist yet",
            mappingInvalid:
              "Invalid port mapping —output maps to an undeclared parent port",
          },
        },
      },
    },
  }),
}));

rs.mock("@/core/agents/api", () => ({
  checkAgentName: rs.fn(),
}));

rs.mock("@/core/model-profiles/hooks", () => ({
  useModelProfiles: () => ({ data: [], isLoading: false, error: null }),
}));

rs.mock("@/core/workflows/api", () => ({
  previewWorkflowPrompt: rs.fn().mockResolvedValue({
    node_id: "n_1",
    prompt: "",
    system_prompt: "",
    task_prompt: "",
    capability_groups: [],
    omitted_runtime_blocks: [],
    components: [],
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

rs.mock("@/components/workspace/workflows/use-open-subworkflow", () => ({
  useOpenSubworkflow: () => rs.fn(),
}));

let agentOptions: { name: string }[] = [{ name: "researcher" }];
let skillOptions: string[] = ["web-research", "code-review"];
let templateOptions: {
  id: string;
  name: string;
  version: string;
  startOutputPorts?: { name: string; type: string }[];
  endOutputPorts?: { name: string; type: string }[];
}[] = [
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
    params: {},
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

describe("WorkflowNodeForm —ai:llm_agent", () => {
  it("renders the selected agent", () => {
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Agent" }).textContent,
    ).toContain("researcher");
  });

  it("renders the continue-prompt wiring hint without an editable textarea", () => {
    render(
      <WorkflowNodeForm
        node={makeAINode()}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByText("Continue prompt")).toBeTruthy();
    expect(
      screen.getByText("Wire into continue_prompt on the canvas to resume"),
    ).toBeTruthy();
    // No textarea —the value arrives via canvas edges, not the form.
    expect(screen.queryByLabelText("Continue prompt")).toBeNull();
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
    fireEvent.click(
      screen.getByRole("option", { name: "Lead agent (default)" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ agent_name: null }),
    );
  });
});

describe("WorkflowNodeForm —nested:subworkflow", () => {
  it("renders template options as name (version) and keeps the current spec", () => {
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode()}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    openSelect("Workflow template");
    expect(screen.getByRole("option", { name: "Alpha (0.1.0)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Beta (0.2.0)" })).toBeTruthy();
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

describe("WorkflowNodeForm —nested:subworkflow port mapping", () => {
  function renderPorted(
    onChange: ReturnType<typeof rs.fn>,
    workflow: Partial<WorkflowNode> = {},
    readonly = false,
  ) {
    templateOptions = [
      {
        id: "wf-1",
        name: "Alpha",
        version: "0.1.0",
        startOutputPorts: [{ name: "query", type: "data" }],
        endOutputPorts: [{ name: "result", type: "data" }],
      },
    ];
    return render(
      <WorkflowNodeForm
        node={makeSubworkflowNode({
          inputs: [{ name: "user_input", type: "data" }],
          outputs: [{ name: "out", type: "data" }],
          ...workflow,
        })}
        readonly={readonly}
        onChange={onChange}
      />,
    );
  }

  it("renders mapping rows for the template start/end output ports", () => {
    renderPorted(rs.fn());

    expect(screen.getByText("Port mapping")).toBeTruthy();
    expect(screen.getByText("Input mapping")).toBeTruthy();
    expect(screen.getByText("Output mapping")).toBeTruthy();
    // Fixed row labels are the child ports.
    expect(screen.getByText("query")).toBeTruthy();
    expect(screen.getByText("result")).toBeTruthy();
    // Each row carries a select whose options are the parent ports.
    expect(
      screen.getByRole("combobox", { name: "Input mapping: query" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Output mapping: result" }),
    ).toBeTruthy();
  });

  it("commits input and output mappings into params.mapping", () => {
    const onChange = rs.fn();
    renderPorted(onChange);

    openSelect("Input mapping: query");
    fireEvent.click(screen.getByRole("option", { name: "user_input" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          mapping: {
            inputs: { query: "user_input" },
            outputs: {},
          },
        }),
      }),
    );

    openSelect("Output mapping: result");
    fireEvent.click(screen.getByRole("option", { name: "out" }));

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          mapping: {
            inputs: { query: "user_input" },
            outputs: { result: "out" },
          },
        }),
      }),
    );
  });

  it("clears one mapping and keeps the other side", () => {
    const onChange = rs.fn();
    renderPorted(onChange, {
      params: {
        subworkflow: {
          type: "template",
          mode: "compile",
          template_id: "wf-1",
          version: "0.1.0",
        },
        mapping: {
          inputs: { query: "user_input" },
          outputs: { result: "out" },
        },
      },
    });

    openSelect("Input mapping: query");
    fireEvent.click(screen.getByRole("option", { name: "Not mapped" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          mapping: {
            inputs: {},
            outputs: { result: "out" },
          },
        }),
      }),
    );
  });

  it("removes params.mapping entirely when the last mapping is cleared", () => {
    const onChange = rs.fn();
    renderPorted(onChange, {
      params: {
        subworkflow: {
          type: "template",
          mode: "compile",
          template_id: "wf-1",
          version: "0.1.0",
        },
        mapping: {
          inputs: { query: "user_input" },
          outputs: {},
        },
      },
    });

    openSelect("Input mapping: query");
    fireEvent.click(screen.getByRole("option", { name: "Not mapped" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as WorkflowNode;
    expect(next.params.mapping).toBeUndefined();
  });

  it("disables every mapping select when readonly", () => {
    renderPorted(rs.fn(), {}, true);

    const inputSelect = screen.getByRole<HTMLButtonElement>("combobox", {
      name: "Input mapping: query",
    });
    const outputSelect = screen.getByRole<HTMLButtonElement>("combobox", {
      name: "Output mapping: result",
    });
    expect(inputSelect.disabled).toBe(true);
    expect(outputSelect.disabled).toBe(true);
  });

  it("does not render the mapping section without a selected template", () => {
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode({
          inputs: [{ name: "user_input", type: "data" }],
          outputs: [{ name: "out", type: "data" }],
          params: {},
        })}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.queryByText("Port mapping")).toBeNull();
  });

  it("does not render the mapping section when the template has no ports", () => {
    templateOptions = [{ id: "wf-1", name: "Alpha", version: "0.1.0" }];
    render(
      <WorkflowNodeForm
        node={makeSubworkflowNode({
          inputs: [{ name: "user_input", type: "data" }],
          outputs: [{ name: "out", type: "data" }],
        })}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.queryByText("Port mapping")).toBeNull();
  });

  it("shows the mapping-invalid error for an output mapped to an undeclared parent port", () => {
    renderPorted(rs.fn(), {
      outputs: [],
      params: {
        subworkflow: {
          type: "template",
          mode: "compile",
          template_id: "wf-1",
          version: "0.1.0",
        },
        mapping: {
          inputs: {},
          outputs: { result: "ghost" },
        },
      },
    });

    expect(
      screen.getByText(
        "Invalid port mapping —output maps to an undeclared parent port",
      ),
    ).toBeTruthy();
  });
});
describe("WorkflowNodeForm — fixed params", () => {
  it("renders the fixed params editor for a simple node", () => {
    render(
      <WorkflowNodeForm
        node={makeNode("n_3", "flow:if")}
        readonly={false}
        onChange={rs.fn()}
      />,
    );

    expect(screen.getByLabelText("Breakpoint")).toBeTruthy();
  });
});
