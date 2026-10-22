import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkflowSchemaForm } from "@/components/workspace/workflows/workflow-schema-form";
import type { WorkflowNode } from "@/core/workflows/canvas/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        properties: {
          schema: {
            title: "AI Result Schema",
            hint: "Common fields are fixed",
            commonTitle: "Common fields",
            commonHint: "Common hint",
            customTitle: "Custom fields",
            addField: "Add field",
            noFields: "No custom fields",
            invalid: "Invalid fields",
            name: "Field name",
            type: "Type",
            required: "Required",
            optional: "Optional",
            description: "Description",
            descriptionPlaceholder: "Description",
            enumValues: "Enum values",
            enumValuesPlaceholder: "approve, reject",
            removeField: "Remove field",
            maxRepairs: "Max repairs",
            referencesTitle: "References",
            referencesHint: "Use [schema.summary]",
            usageTitle: "Usage",
            inputUsage: "As input",
            outputUsage: "As output",
            none: "None",
            rawJson: "Raw JSON",
          },
        },
      },
    },
  }),
}));

rs.mock("@/components/workspace/workflows/workflow-editor-context", () => ({
  useWorkflowEditor: () => ({
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

function makeNode(fields: unknown[] = []): {
  id: string;
  data: { workflow: WorkflowNode };
} {
  return {
    id: "n_schema",
    data: {
      workflow: {
        id: "n_schema",
        type: "data:schema",
        inputs: [],
        outputs: [{ name: "schema", type: "record", required: true }],
        params: {
          schema: { version: 1, max_repairs: 1, custom_fields: fields },
        },
        capability_groups: [],
        agent_name: null,
      },
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("WorkflowSchemaForm", () => {
  it("shows the fixed common fields and adds a custom field", () => {
    const onChange = rs.fn();
    render(
      <WorkflowSchemaForm
        node={makeNode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("AI Result Schema")).toBeTruthy();
    expect(screen.getByText("[schema.summary]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));

    const next = onChange.mock.calls[0]![0] as WorkflowNode;
    expect(next.params.schema).toMatchObject({
      version: 1,
      custom_fields: [{ name: "field_1", type: "data" }],
    });
  });

  it("removes an existing custom field", () => {
    const onChange = rs.fn();
    render(
      <WorkflowSchemaForm
        node={makeNode([
          {
            name: "decision",
            type: "enum",
            required: true,
            description: "Decision",
            enum_values: ["approve", "reject"],
          },
        ])}
        readonly={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove field" }));

    const next = onChange.mock.calls[0]![0] as WorkflowNode;
    expect(next.params.schema).toMatchObject({ custom_fields: [] });
  });
});
