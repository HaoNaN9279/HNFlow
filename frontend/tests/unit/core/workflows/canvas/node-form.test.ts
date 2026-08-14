import { describe, expect, test } from "@rstest/core";

import {
  definitionToFlow,
  flowToDefinition,
} from "@/core/workflows/canvas/mapping";
import {
  applyNodeFormValues,
  parseNodeFormValues,
  parseSubworkflowSpec,
  serializeSubworkflowSpec,
  validateNodeForm,
  type NodeFormValues,
} from "@/core/workflows/canvas/node-form";
import {
  AGENT_NAME_PATTERN,
  AI_NODE_FIELDS,
  SUBWORKFLOW_FIELDS,
} from "@/core/workflows/canvas/node-form-schema";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import type { WorkflowDefinition } from "@/core/workflows/types";

const aiNode = (): WorkflowNode => ({
  id: "n-llm",
  type: "ai:llm_agent",
  inputs: [],
  outputs: [],
  params: { instruction: "Summarize the input", extra: 1 },
  capability_groups: ["research", "web"],
  agent_name: "lead",
});

const subworkflowNode = (): WorkflowNode => ({
  id: "n-sub",
  type: "nested:subworkflow",
  inputs: [],
  outputs: [],
  params: {
    subworkflow: {
      type: "template",
      mode: "compile",
      template_id: "wf-001",
      version: "0.2.0",
    },
  },
  capability_groups: [],
  agent_name: null,
});

const mappingNode = (): WorkflowNode => ({
  id: "n-sub",
  type: "nested:subworkflow",
  inputs: [{ name: "child_in", type: "data", required: true }],
  outputs: [{ name: "child_out", type: "data" }],
  params: {
    subworkflow: {
      type: "template",
      mode: "compile",
      template_id: "wf-001",
      version: "0.2.0",
    },
    mapping: {
      inputs: { child_in: "wf:start:parent_in" },
      outputs: { child_out: "parent_out" },
    },
  },
  capability_groups: [],
  agent_name: null,
});

describe("node form schema", () => {
  test("AI_NODE_FIELDS covers instruction/agent_name/capability_groups", () => {
    expect(AI_NODE_FIELDS.map((f) => f.key)).toEqual([
      "instruction",
      "agent_name",
      "capability_groups",
    ]);
    const byKey = Object.fromEntries(AI_NODE_FIELDS.map((f) => [f.key, f]));
    expect(byKey.instruction?.kind).toBe("textarea");
    expect(byKey.instruction?.required).toBe(true);
    expect(byKey.agent_name?.kind).toBe("select");
    expect(byKey.agent_name?.pattern).toBe(AGENT_NAME_PATTERN);
    expect(byKey.agent_name?.options?.[0]?.value).toBe("None");
    expect(byKey.capability_groups?.kind).toBe("multi-select");
  });

  test("SUBWORKFLOW_FIELDS covers template_id and version", () => {
    expect(SUBWORKFLOW_FIELDS.map((f) => f.key)).toEqual([
      "template_id",
      "version",
    ]);
    const templateId = SUBWORKFLOW_FIELDS.find((f) => f.key === "template_id")!;
    expect(templateId.kind).toBe("workflow-template");
    expect(templateId.required).toBe(true);
  });

  test("AGENT_NAME_PATTERN mirrors the backend regex", () => {
    expect(AGENT_NAME_PATTERN.source).toBe("^[A-Za-z0-9-]+$");
    expect(AGENT_NAME_PATTERN.test("lead")).toBe(true);
    expect(AGENT_NAME_PATTERN.test("researcher-2")).toBe(true);
    expect(AGENT_NAME_PATTERN.test("my_agent")).toBe(false);
    expect(AGENT_NAME_PATTERN.test("my.agent")).toBe(false);
    expect(AGENT_NAME_PATTERN.test("智能体")).toBe(false);
  });
});

describe("parseNodeFormValues", () => {
  test("reads instruction from params, top-level fields, and subworkflow spec", () => {
    const node = {
      ...subworkflowNode(),
      agent_name: "researcher-2",
      capability_groups: ["web"],
    };
    const values = parseNodeFormValues(node);
    expect(values.instruction).toBe("");
    expect(values.agent_name).toBe("researcher-2");
    expect(values.capability_groups).toEqual(["web"]);
    expect(values.template_id).toBe("wf-001");
    expect(values.version).toBe("0.2.0");
  });

  test("tolerates missing fields and non-dict subworkflow specs", () => {
    const missing: WorkflowNode = {
      id: "n-min",
      type: "ai:llm_agent",
      inputs: [],
      outputs: [],
      params: { subworkflow: "not-a-dict", instruction: 42 },
    };
    const values = parseNodeFormValues(missing);
    expect(values.instruction).toBe("");
    expect(values.agent_name).toBe("");
    expect(values.capability_groups).toEqual([]);
    expect(values.template_id).toBeUndefined();
    expect(values.version).toBeUndefined();
  });

  test("coerces non-string instruction to an empty string", () => {
    const node: WorkflowNode = { ...aiNode(), params: { instruction: 7 } };
    expect(parseNodeFormValues(node).instruction).toBe("");
  });

  test("copies capability_groups so the caller cannot mutate the node", () => {
    const node = aiNode();
    const values = parseNodeFormValues(node);
    values.capability_groups!.push("injected");
    expect(node.capability_groups).toEqual(["research", "web"]);
  });
});

describe("applyNodeFormValues", () => {
  test("parse → apply round-trips an AI node (top-level fields + instruction)", () => {
    const node = aiNode();
    const applied = applyNodeFormValues(node, parseNodeFormValues(node));
    expect(applied).toEqual(node);
    expect(applied).not.toBe(node);
  });

  test("parse → apply round-trips a subworkflow node's template fields", () => {
    const node = subworkflowNode();
    const applied = applyNodeFormValues(node, parseNodeFormValues(node));
    expect(applied).not.toBe(node);
    // apply always writes the full form shape; the subworkflow fields round-trip exactly.
    expect(applied.params.subworkflow).toEqual(node.params.subworkflow);
    expect(applied.agent_name).toBeNull();
    expect(applied.capability_groups).toEqual([]);
  });

  test("returns a new object and never mutates the original", () => {
    const node = aiNode();
    const before = structuredClone(node);
    const result = applyNodeFormValues(node, {
      instruction: "Changed",
      agent_name: "researcher-2",
      capability_groups: ["web"],
      template_id: "",
    });
    expect(result).not.toBe(node);
    expect(result.params).not.toBe(node.params);
    expect(node).toEqual(before);
  });

  test("writes instruction to params and keeps unrelated params", () => {
    const result = applyNodeFormValues(aiNode(), { instruction: "New" });
    expect(result.params).toEqual({ instruction: "New", extra: 1 });
  });

  test("writes template_id/version into params.subworkflow as a compile spec", () => {
    const result = applyNodeFormValues(subworkflowNode(), {
      template_id: "wf-9",
      version: "1.2.3",
    });
    expect(result.params.subworkflow).toEqual({
      type: "template",
      mode: "compile",
      template_id: "wf-9",
      version: "1.2.3",
    });
  });

  test("an empty template_id removes the subworkflow key without touching the original", () => {
    const node = subworkflowNode();
    const result = applyNodeFormValues(node, {
      template_id: "",
      version: "0.1.0",
    });
    expect(result.params).not.toHaveProperty("subworkflow");
    expect(result.params).toEqual({ instruction: "" });
    expect(node.params).toHaveProperty("subworkflow");
  });

  test("an empty agent_name maps to null (lead agent)", () => {
    const node = { ...aiNode(), agent_name: "lead" };
    const result = applyNodeFormValues(node, { agent_name: "" });
    expect(result.agent_name).toBeNull();
    expect(node.agent_name).toBe("lead");
  });

  test("writes capability_groups as a fresh array", () => {
    const node = aiNode();
    const groups = ["web"];
    const result = applyNodeFormValues(node, { capability_groups: groups });
    expect(result.capability_groups).toEqual(["web"]);
    expect(result.capability_groups).not.toBe(groups);
    expect(result.capability_groups).not.toBe(node.capability_groups);
  });
});

describe("validateNodeForm", () => {
  test("flags empty required fields with stable constants", () => {
    expect(validateNodeForm({})).toEqual({
      instruction: "required",
      template_id: "required",
    });
    expect(validateNodeForm({ instruction: "  ", template_id: " " })).toEqual({
      instruction: "required",
      template_id: "required",
    });
  });

  test("rejects invalid agent names (underscore/dot/Chinese/space)", () => {
    const base: NodeFormValues = { instruction: "Hi", template_id: "wf-1" };
    expect(validateNodeForm({ ...base, agent_name: "my_agent" })).toEqual({
      agent_name: "invalid",
    });
    expect(validateNodeForm({ ...base, agent_name: "my.agent" })).toEqual({
      agent_name: "invalid",
    });
    expect(validateNodeForm({ ...base, agent_name: "智能体" })).toEqual({
      agent_name: "invalid",
    });
    expect(validateNodeForm({ ...base, agent_name: "my agent" })).toEqual({
      agent_name: "invalid",
    });
  });

  test("accepts legal values including None and empty agent_name", () => {
    expect(
      validateNodeForm({
        instruction: "Hi",
        template_id: "wf-1",
        agent_name: "None",
      }),
    ).toEqual({});
    expect(
      validateNodeForm({
        instruction: "Hi",
        template_id: "wf-1",
        agent_name: "",
      }),
    ).toEqual({});
    expect(
      validateNodeForm({
        instruction: "Hi",
        template_id: "wf-1",
        agent_name: "researcher-2",
      }),
    ).toEqual({});
  });
});

describe("subworkflow spec helpers", () => {
  test("parseSubworkflowSpec tolerates missing or malformed specs", () => {
    expect(parseSubworkflowSpec({})).toBeNull();
    expect(parseSubworkflowSpec({ subworkflow: "oops" })).toBeNull();
    expect(parseSubworkflowSpec({ subworkflow: 42 })).toBeNull();
    expect(parseSubworkflowSpec({ subworkflow: null })).toBeNull();
    expect(parseSubworkflowSpec({ subworkflow: ["a"] })).toBeNull();
    expect(
      parseSubworkflowSpec({ subworkflow: { type: "inline" } }),
    ).toBeNull();
  });

  test("parseSubworkflowSpec reads template_id/version and ignores non-strings", () => {
    expect(
      parseSubworkflowSpec({
        subworkflow: {
          type: "template",
          template_id: "wf-1",
          version: "0.1.0",
        },
      }),
    ).toEqual({ template_id: "wf-1", version: "0.1.0" });
    expect(
      parseSubworkflowSpec({ subworkflow: { template_id: "wf-2" } }),
    ).toEqual({ template_id: "wf-2" });
    expect(
      parseSubworkflowSpec({ subworkflow: { template_id: 7, version: null } }),
    ).toBeNull();
  });

  test("serializeSubworkflowSpec writes the canonical compile spec", () => {
    expect(
      serializeSubworkflowSpec({ template_id: "wf-1", version: "0.1.0" }),
    ).toEqual({
      type: "template",
      mode: "compile",
      template_id: "wf-1",
      version: "0.1.0",
    });
    expect(serializeSubworkflowSpec({ template_id: "wf-2" })).toEqual({
      type: "template",
      mode: "compile",
      template_id: "wf-2",
    });
  });
});

describe("F4 verification — mapping layer passes top-level fields through", () => {
  test("definitionToFlow → flowToDefinition round-trip preserves top-level agent fields", () => {
    const def: WorkflowDefinition = {
      id: "wf-1",
      name: "Sample",
      version: "0.1.0",
      metadata: {},
      nodes: [aiNode(), subworkflowNode()],
      edges: [],
    };

    const flow = definitionToFlow(def);
    const { definition } = flowToDefinition(flow, { def, positions: {} });

    expect(definition.nodes[0]!.agent_name).toBe("lead");
    expect(definition.nodes[0]!.capability_groups).toEqual(["research", "web"]);
    expect(definition.nodes[1]!.agent_name).toBeNull();
    expect(definition.nodes[1]!.capability_groups).toEqual([]);
    expect(definition.nodes).toEqual(def.nodes);
  });
});

describe("parseNodeFormValues — params.mapping", () => {
  test("reads params.mapping into mapping form values", () => {
    const values = parseNodeFormValues(mappingNode());
    expect(values.mapping).toEqual({
      inputs: { child_in: "wf:start:parent_in" },
      outputs: { child_out: "parent_out" },
    });
  });

  test("tolerates a non-dict mapping.inputs by degrading to an empty dict", () => {
    const node: WorkflowNode = {
      ...mappingNode(),
      params: {
        ...mappingNode().params,
        mapping: { inputs: "oops", outputs: { child_out: "parent_out" } },
      },
    };
    expect(parseNodeFormValues(node).mapping).toEqual({
      inputs: {},
      outputs: { child_out: "parent_out" },
    });
  });

  test("treats a missing mapping.outputs as an empty dict", () => {
    const node: WorkflowNode = {
      ...mappingNode(),
      params: {
        ...mappingNode().params,
        mapping: { inputs: { child_in: "wf:start:parent_in" } },
      },
    };
    expect(parseNodeFormValues(node).mapping).toEqual({
      inputs: { child_in: "wf:start:parent_in" },
      outputs: {},
    });
  });

  test("drops non-string mapping values", () => {
    const node: WorkflowNode = {
      ...mappingNode(),
      params: {
        ...mappingNode().params,
        mapping: {
          inputs: { child_in: 42, child_ok: "wf:start:x" },
          outputs: {},
        },
      },
    };
    expect(parseNodeFormValues(node).mapping).toEqual({
      inputs: { child_ok: "wf:start:x" },
      outputs: {},
    });
  });

  test("degrades a non-dict params.mapping to an empty mapping", () => {
    const node: WorkflowNode = {
      ...subworkflowNode(),
      params: { ...subworkflowNode().params, mapping: "not-a-dict" },
    };
    expect(parseNodeFormValues(node).mapping).toEqual({
      inputs: {},
      outputs: {},
    });
  });

  test("leaves mapping undefined when params has no mapping key", () => {
    expect(parseNodeFormValues(subworkflowNode()).mapping).toBeUndefined();
  });
});

describe("applyNodeFormValues — params.mapping", () => {
  test("writes a non-empty mapping back into params and keeps unrelated params", () => {
    const node: WorkflowNode = {
      ...subworkflowNode(),
      params: { ...subworkflowNode().params, extra: 1 },
    };
    const result = applyNodeFormValues(node, {
      template_id: "wf-9",
      mapping: { inputs: { child_in: "wf:start:parent_in" }, outputs: {} },
    });
    expect(result.params.mapping).toEqual({
      inputs: { child_in: "wf:start:parent_in" },
      outputs: {},
    });
    expect(result.params.extra).toBe(1);
    expect(node.params).not.toHaveProperty("mapping");
  });

  test("an empty mapping removes the params.mapping key without touching the original", () => {
    const node = mappingNode();
    const result = applyNodeFormValues(node, {
      mapping: { inputs: {}, outputs: {} },
    });
    expect(result.params).not.toHaveProperty("mapping");
    expect(node.params).toHaveProperty("mapping");
  });

  test("an undefined mapping removes the params.mapping key", () => {
    const node = mappingNode();
    const result = applyNodeFormValues(node, {});
    expect(result.params).not.toHaveProperty("mapping");
  });

  test("mapping round-trips through parse → apply", () => {
    const node = mappingNode();
    const result = applyNodeFormValues(node, parseNodeFormValues(node));
    expect(result.params.mapping).toEqual(node.params.mapping);
    expect(result).not.toBe(node);
  });
});

describe("validateNodeForm — mapping", () => {
  const base: NodeFormValues = { instruction: "Hi", template_id: "wf-1" };

  test("flags an empty mapping output parent port", () => {
    expect(
      validateNodeForm({
        ...base,
        mapping: { inputs: {}, outputs: { child_out: "" } },
      }),
    ).toEqual({ "mapping.outputs": "invalid" });
    expect(
      validateNodeForm({
        ...base,
        mapping: { inputs: {}, outputs: { child_out: "   " } },
      }),
    ).toEqual({ "mapping.outputs": "invalid" });
  });

  test("flags a mapping output parent port not declared on the node outputs", () => {
    expect(
      validateNodeForm(
        {
          ...base,
          mapping: { inputs: {}, outputs: { child_out: "missing_out" } },
        },
        mappingNode(),
      ),
    ).toEqual({ "mapping.outputs": "invalid" });
  });

  test("accepts mapping output parent ports declared on the node outputs", () => {
    expect(
      validateNodeForm(
        {
          ...base,
          mapping: {
            inputs: { child_in: "wf:start:parent_in" },
            outputs: { child_out: "child_out" },
          },
        },
        mappingNode(),
      ),
    ).toEqual({});
  });

  test("without a node, mapping validation only checks for non-empty parent ports", () => {
    expect(
      validateNodeForm({
        ...base,
        mapping: { inputs: {}, outputs: { child_out: "any-parent-port" } },
      }),
    ).toEqual({});
  });

  test("a mapping with only inputs never adds mapping errors", () => {
    expect(
      validateNodeForm({
        ...base,
        mapping: { inputs: { child_in: "wf:start:parent_in" }, outputs: {} },
      }),
    ).toEqual({});
  });
});
