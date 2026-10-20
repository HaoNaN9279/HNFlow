import { describe, expect, it } from "@rstest/core";

import {
  readSubworkflowSaveMode,
  readSubworkflowSource,
  subworkflowSourceId,
  withGlobalSubworkflowReference,
  withLocalSubworkflowSnapshot,
} from "@/core/workflows/canvas/subworkflow";
import type { WorkflowDefinition } from "@/core/workflows/types";

function childDefinition(): WorkflowDefinition {
  return {
    id: "wf-b",
    name: "Child B",
    version: "1.2.0",
    nodes: [],
    edges: [],
    metadata: {},
  };
}

function node() {
  return {
    id: "n_sub",
    type: "nested:subworkflow" as const,
    inputs: [],
    outputs: [],
    params: {
      subworkflow: {
        type: "template",
        mode: "compile",
        template_id: "wf-b",
        version: "1.2.0",
      },
      mapping: { inputs: {}, outputs: {} },
    },
    capability_groups: [],
    agent_name: null,
  };
}

describe("subworkflow save modes", () => {
  it("treats a template reference as global by default", () => {
    const source = readSubworkflowSource(node().params);

    expect(source).toMatchObject({
      kind: "template",
      templateId: "wf-b",
      version: "1.2.0",
      saveMode: "global",
    });
    expect(readSubworkflowSaveMode(node().params)).toBe("global");
    expect(subworkflowSourceId(source)).toBe("wf-b");
  });

  it("turns a template reference into a local inline snapshot", () => {
    const local = withLocalSubworkflowSnapshot(
      node(),
      childDefinition(),
      "wf-b",
      "1.2.0",
    );
    const spec = local.params.subworkflow as Record<string, unknown>;
    const source = readSubworkflowSource(local.params);

    expect(spec.type).toBe("inline");
    expect(spec.save_mode).toBe("local");
    expect(spec.source_template_id).toBe("wf-b");
    expect(local.params.mapping).toEqual({ inputs: {}, outputs: {} });
    expect(source).toMatchObject({
      kind: "inline",
      saveMode: "local",
      sourceTemplateId: "wf-b",
      definition: childDefinition(),
    });
    expect(readSubworkflowSaveMode(local.params)).toBe("local");
  });

  it("restores a template reference from a local snapshot", () => {
    const local = withLocalSubworkflowSnapshot(
      node(),
      childDefinition(),
      "wf-b",
      "1.2.0",
    );
    const global = withGlobalSubworkflowReference(local, "wf-b", "1.2.0");

    expect(global.params.subworkflow).toEqual({
      type: "template",
      mode: "compile",
      save_mode: "global",
      template_id: "wf-b",
      version: "1.2.0",
    });
    expect(readSubworkflowSaveMode(global.params)).toBe("global");
  });
});
