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
            title: "Schema",
            hint: "Common fields are fixed",
            commonTitle: "Common fields",
            commonHint: "Common hint",
            commonFieldHints: {
              summary: "Summary hint",
              status: "Status hint",
              content: "Content hint",
              artifacts: "Artifacts hint",
              metadata: "Metadata hint",
              error: "Error hint",
            },
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
            rawJson: "Raw JSON",
          },
        },
      },
    },
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
  it("shows common field semantics and adds a custom field", () => {
    const onChange = rs.fn();
    render(
      <WorkflowSchemaForm
        node={makeNode()}
        readonly={false}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Schema")).toBeTruthy();
    expect(screen.getByText("Summary hint")).toBeTruthy();
    expect(screen.getByText("Error hint")).toBeTruthy();
    expect(screen.queryByText("References")).toBeNull();
    expect(screen.queryByText("Usage")).toBeNull();
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
