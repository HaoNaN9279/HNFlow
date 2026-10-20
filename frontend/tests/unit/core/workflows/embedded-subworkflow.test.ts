import { describe, expect, it } from "@rstest/core";

import { definitionToFlow } from "@/core/workflows/canvas/mapping";
import { updateEmbeddedDefinitionInNodes } from "@/core/workflows/embedded-subworkflow";
import type { WorkflowDefinition } from "@/core/workflows/types";

function definition(
  id: string,
  name: string,
  inner?: WorkflowDefinition,
): WorkflowDefinition {
  return {
    id,
    name,
    version: "0.1.0",
    metadata: {},
    edges: [],
    nodes: [
      {
        id: `n_${id}`,
        type: "nested:subworkflow",
        inputs: [],
        outputs: [],
        params: {
          subworkflow: inner
            ? {
                type: "inline",
                save_mode: "local",
                source_template_id: inner.id,
                definition: inner,
              }
            : { type: "template", template_id: "wf-leaf" },
        },
        capability_groups: [],
        agent_name: null,
      },
    ],
  };
}

describe("embedded subworkflow updates", () => {
  it("replaces an inline definition at the requested node", () => {
    const parent = definition(
      "wf-a",
      "Parent",
      definition("wf-b", "Original child"),
    );
    const flow = definitionToFlow(parent);
    const nextLeaf: WorkflowDefinition = {
      ...definition("wf-b", "New child"),
      name: "Changed child",
    };

    const updated = updateEmbeddedDefinitionInNodes(
      flow.nodes,
      ["n_wf-a"],
      nextLeaf,
    );
    const spec = updated[0]!.data.workflow.params.subworkflow as {
      definition: WorkflowDefinition;
    };

    expect(spec.definition.name).toBe("Changed child");
  });

  it("descends into nested local snapshots", () => {
    const leaf = definition("wf-leaf", "Leaf");
    const child = definition("wf-b", "Child", leaf);
    const root = definition("wf-a", "Root", child);
    const flow = definitionToFlow(root);
    const updatedLeaf: WorkflowDefinition = {
      ...leaf,
      name: "Updated leaf",
    };

    const updated = updateEmbeddedDefinitionInNodes(
      flow.nodes,
      ["n_wf-a", "n_wf-b"],
      updatedLeaf,
    );
    const outer = updated[0]!.data.workflow.params.subworkflow as {
      definition: WorkflowDefinition;
    };
    const innerNode = outer.definition.nodes[0]!;
    const inner = innerNode.params.subworkflow as {
      definition: WorkflowDefinition;
    };

    expect(inner.definition.name).toBe("Updated leaf");
  });

  it("fails loudly when the path does not name an inline subworkflow", () => {
    const parent = definition("wf-a", "Parent");
    const flow = definitionToFlow(parent);

    expect(() =>
      updateEmbeddedDefinitionInNodes(flow.nodes, ["missing"], parent),
    ).toThrow(/not found/);
  });
});
