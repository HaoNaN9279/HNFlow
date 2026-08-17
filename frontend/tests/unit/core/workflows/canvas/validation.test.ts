import { describe, expect, test } from "@rstest/core";

import type { RFNode } from "@/core/workflows/canvas/mapping";
import {
  PORT_TYPES,
  isPortCompatible,
  validateConnection,
  validateWorkflow,
} from "@/core/workflows/canvas/validation";
import type { WorkflowDefinition } from "@/core/workflows/types";

const node = (
  id: string,
  type: string,
  inputs: string[],
  outputs: string[],
): RFNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: {
    workflow: {
      id,
      type: type as never,
      inputs: inputs.map((name) => ({ name, type: portTypeOf(name) })),
      outputs: outputs.map((name) => ({ name, type: portTypeOf(name) })),
      params: {},
      capability_groups: [],
      agent_name: null,
    },
  },
});

const portTypeOf = (name: string): "data" | "file" | "bool" | "enum" => {
  if (name === "in" || name === "out") return "data";
  if (name === "fileIn" || name === "fileOut") return "file";
  if (name === "true" || name === "false" || name === "boolOut") return "bool";
  if (name === "enumIn" || name === "enumOut") return "enum";
  throw new Error(`no fixture port type for ${name}`);
};

const fixtureNodes = (): RFNode[] => [
  node("n-a", "data:assign", ["in"], ["out"]),
  node("n-b", "data:file", ["fileIn"], ["fileOut"]),
  node("n-c", "flow:if", ["in"], ["true", "false"]),
  node("n-d", "data:convert", ["in"], ["out"]),
  node("n-e", "data:json", ["in", "enumIn"], ["out"]),
];

const validDefinition = (): WorkflowDefinition => ({
  id: "wf-1",
  name: "Sample",
  version: "0.1.0",
  metadata: {},
  nodes: [
    {
      id: "n-start",
      type: "flow:start",
      inputs: [],
      outputs: [{ name: "out", type: "data" }],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
    {
      id: "n-a",
      type: "data:assign",
      inputs: [{ name: "in", type: "data" }],
      outputs: [{ name: "out", type: "data" }],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
    {
      id: "n-end",
      type: "flow:end",
      inputs: [{ name: "in", type: "data" }],
      outputs: [],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
  ],
  edges: [
    { source: "n-start", source_port: "out", target: "n-a", target_port: "in" },
    { source: "n-a", source_port: "out", target: "n-end", target_port: "in" },
  ],
});

describe("PORT_TYPES", () => {
  test("is locked to the 4 backend values", () => {
    expect(PORT_TYPES).toEqual(["data", "file", "bool", "enum"]);
  });
});

describe("isPortCompatible", () => {
  test("strict same-type matching passes", () => {
    for (const type of PORT_TYPES) {
      expect(isPortCompatible(type, type)).toBe(true);
    }
  });

  test("rejects every cross-type pair", () => {
    for (const src of PORT_TYPES) {
      for (const dst of PORT_TYPES) {
        if (src !== dst) {
          expect(isPortCompatible(src, dst)).toBe(false);
        }
      }
    }
  });

  test("rejects the documented pairs data↔file and bool↔enum", () => {
    expect(isPortCompatible("data", "file")).toBe(false);
    expect(isPortCompatible("file", "data")).toBe(false);
    expect(isPortCompatible("bool", "enum")).toBe(false);
    expect(isPortCompatible("enum", "bool")).toBe(false);
  });
});

describe("validateConnection", () => {
  const nodes = fixtureNodes();

  test("allows same-type connections", () => {
    expect(
      validateConnection(
        {
          source: "n-a",
          sourceHandle: "out",
          target: "n-d",
          targetHandle: "in",
        },
        nodes,
      ),
    ).toEqual({ ok: true });
    expect(
      validateConnection(
        {
          source: "n-b",
          sourceHandle: "fileOut",
          target: "n-b",
          targetHandle: "fileIn",
        },
        [nodes[1]!],
      ),
    ).toEqual({ ok: false, reason: "workflows.errors.selfConnection" });
  });

  test("rejects cross-type data↔file", () => {
    expect(
      validateConnection(
        {
          source: "n-a",
          sourceHandle: "out",
          target: "n-b",
          targetHandle: "fileIn",
        },
        nodes,
      ),
    ).toEqual({
      ok: false,
      reason: "workflows.errors.portTypeMismatch",
    });
  });

  test("rejects cross-type bool↔enum", () => {
    expect(
      validateConnection(
        {
          source: "n-c",
          sourceHandle: "true",
          target: "n-e",
          targetHandle: "enumIn",
        },
        nodes,
      ),
    ).toEqual({
      ok: false,
      reason: "workflows.errors.portTypeMismatch",
    });
  });

  test("rejects self connections even when ports match", () => {
    expect(
      validateConnection(
        {
          source: "n-a",
          sourceHandle: "out",
          target: "n-a",
          targetHandle: "in",
        },
        nodes,
      ),
    ).toEqual({
      ok: false,
      reason: "workflows.errors.selfConnection",
    });
  });

  test("rejects missing source ports", () => {
    expect(
      validateConnection(
        {
          source: "n-a",
          sourceHandle: "nope",
          target: "n-d",
          targetHandle: "in",
        },
        nodes,
      ),
    ).toEqual({
      ok: false,
      reason: "workflows.errors.portNotFound",
    });
  });

  test("rejects missing target ports", () => {
    expect(
      validateConnection(
        {
          source: "n-a",
          sourceHandle: "out",
          target: "n-d",
          targetHandle: "nope",
        },
        nodes,
      ),
    ).toEqual({
      ok: false,
      reason: "workflows.errors.portNotFound",
    });
  });

  test("rejects connections to unknown nodes", () => {
    expect(
      validateConnection(
        {
          source: "n-zzz",
          sourceHandle: "out",
          target: "n-d",
          targetHandle: "in",
        },
        nodes,
      ),
    ).toEqual({
      ok: false,
      reason: "workflows.errors.portNotFound",
    });
  });
});

describe("validateWorkflow", () => {
  test("returns no errors for a valid definition", () => {
    expect(validateWorkflow(validDefinition())).toEqual([]);
  });

  test("flags a missing start node", () => {
    const def = validDefinition();
    def.nodes = def.nodes.filter((n) => n.type !== "flow:start");
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.missingStartNode",
    );
  });

  test("flags multiple start nodes", () => {
    const def = validDefinition();
    def.nodes.push({
      id: "n-start-2",
      type: "flow:start",
      inputs: [],
      outputs: [],
      params: {},
      capability_groups: [],
      agent_name: null,
    });
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.multipleStartNodes",
    );
  });

  test("flags a start node with incoming edges", () => {
    const def = validDefinition();
    def.edges.push({
      source: "n-a",
      source_port: "out",
      target: "n-start",
      target_port: "out",
    });
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.startHasIncomingEdge",
    );
  });

  test("flags a missing end node", () => {
    const def = validDefinition();
    def.nodes = def.nodes.filter((n) => n.type !== "flow:end");
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.missingEndNode",
    );
  });

  test("flags multiple end nodes", () => {
    const def = validDefinition();
    def.nodes.push({
      id: "n-end-2",
      type: "flow:end",
      inputs: [],
      outputs: [],
      params: {},
      capability_groups: [],
      agent_name: null,
    });
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.multipleEndNodes",
    );
  });

  test("flags an end node with outgoing edges", () => {
    const def = validDefinition();
    def.edges.push({
      source: "n-end",
      source_port: "in",
      target: "n-a",
      target_port: "in",
    });
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.endHasOutgoingEdge",
    );
  });

  test("flags edges referencing missing nodes", () => {
    const def = validDefinition();
    def.edges.push({
      source: "n-ghost",
      source_port: "out",
      target: "n-a",
      target_port: "in",
    });
    def.edges.push({
      source: "n-a",
      source_port: "out",
      target: "n-ghost",
      target_port: "in",
    });
    const codes = validateWorkflow(def).map((e) => e.code);
    expect(codes).toContain("workflows.errors.edgeSourceNotFound");
    expect(codes).toContain("workflows.errors.edgeTargetNotFound");
  });

  test("flags edges referencing missing ports", () => {
    const def = validDefinition();
    def.edges.push({
      source: "n-start",
      source_port: "nope",
      target: "n-a",
      target_port: "in",
    });
    def.edges.push({
      source: "n-a",
      source_port: "out",
      target: "n-end",
      target_port: "nope",
    });
    const codes = validateWorkflow(def).map((e) => e.code);
    expect(codes).toContain("workflows.errors.sourcePortNotFound");
    expect(codes).toContain("workflows.errors.targetPortNotFound");
  });

  test("flags incompatible port types on edges", () => {
    const def = validDefinition();
    def.nodes.push({
      id: "n-file",
      type: "data:file",
      inputs: [{ name: "in", type: "file" }],
      outputs: [{ name: "out", type: "file" }],
      params: {},
      capability_groups: [],
      agent_name: null,
    });
    def.edges.push({
      source: "n-a",
      source_port: "out",
      target: "n-file",
      target_port: "in",
    });
    expect(validateWorkflow(def).map((e) => e.code)).toContain(
      "workflows.errors.portTypeMismatch",
    );
  });

  test("every error carries a code and a readable message", () => {
    const def = validDefinition();
    def.nodes = [];
    def.edges = [];
    for (const error of validateWorkflow(def)) {
      expect(typeof error.code).toBe("string");
      expect(error.code.length).toBeGreaterThan(0);
      expect(typeof error.message).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});
