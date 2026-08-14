import { describe, expect, test } from "@rstest/core";

import {
  NODE_CATEGORIES,
  getDefaultNode,
  getNodeCatalog,
  getNodeCatalogEntry,
  makeNodeId,
} from "@/core/workflows/canvas/node-catalog";
import { NODE_TYPES, type NodeType } from "@/core/workflows/types";

describe("node catalog", () => {
  test("covers exactly the 19 backend node types", () => {
    const catalog = getNodeCatalog();
    expect(catalog).toHaveLength(19);
    expect(catalog.map((e) => e.type).sort()).toEqual([...NODE_TYPES].sort());
  });

  test("every entry has a label, description and category", () => {
    for (const entry of getNodeCatalog()) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(["flow", "data", "tool", "ai", "human", "subworkflow"]).toContain(
        entry.category,
      );
    }
  });

  test("category counts match the backend split (7 flow / 5 data / 4 tool + singles)", () => {
    const byCategory = (category: string) =>
      getNodeCatalog().filter((e) => e.category === category).length;
    expect(byCategory("flow")).toBe(7);
    expect(byCategory("data")).toBe(5);
    expect(byCategory("tool")).toBe(4);
    expect(byCategory("ai")).toBe(1);
    expect(byCategory("human")).toBe(1);
    expect(byCategory("subworkflow")).toBe(1);
  });

  test("key default ports align with backend executors", () => {
    const start = getNodeCatalogEntry("flow:start")!;
    expect(start.defaultInputs).toEqual([]);
    expect(start.defaultOutputs.map((p) => p.name)).toEqual(["out"]);

    const end = getNodeCatalogEntry("flow:end")!;
    expect(end.defaultInputs.map((p) => p.name)).toEqual(["in"]);
    expect(end.defaultOutputs).toEqual([]);

    const loop = getNodeCatalogEntry("flow:loop")!;
    expect(loop.defaultOutputs.map((p) => p.name)).toEqual([
      "iteration",
      "out",
    ]);

    const file = getNodeCatalogEntry("data:file")!;
    expect(file.defaultInputs.map((p) => p.type)).toEqual(["file"]);
    expect(file.defaultOutputs.map((p) => p.type)).toEqual(["file"]);
  });

  test("ai:llm_agent declares optional template_prompt/continue_prompt input ports", () => {
    const ai = getNodeCatalogEntry("ai:llm_agent")!;
    expect(ai.defaultInputs.map((p) => p.name)).toEqual([
      "in",
      "template_prompt",
      "continue_prompt",
    ]);
    expect(ai.defaultInputs[0]).toMatchObject({
      name: "in",
      type: "data",
      required: true,
    });
    for (const port of ai.defaultInputs.slice(1)) {
      expect(port).toMatchObject({ type: "data", required: false });
      expect(typeof port.description).toBe("string");
    }
  });

  test("key default params match the task spec", () => {
    expect(getNodeCatalogEntry("flow:switch")!.defaultParams).toEqual({
      cases: [],
    });
    expect(getNodeCatalogEntry("flow:wait")!.defaultParams).toEqual({
      duration: 0,
    });
    expect(getNodeCatalogEntry("data:assign")!.defaultParams).toEqual({
      value: null,
    });
    expect(getNodeCatalogEntry("data:convert")!.defaultParams).toEqual({
      to: "string",
    });
    expect(getNodeCatalogEntry("data:file")!.defaultParams).toEqual({
      operation: "read",
      path: "",
    });
    expect(getNodeCatalogEntry("data:json")!.defaultParams).toEqual({
      operation: "stringify",
    });
    expect(getNodeCatalogEntry("data:regex")!.defaultParams).toEqual({
      pattern: "",
    });
    expect(getNodeCatalogEntry("tool:bash")!.defaultParams).toEqual({
      command: "",
    });
    expect(getNodeCatalogEntry("tool:http")!.defaultParams).toEqual({
      url: "",
    });
    expect(getNodeCatalogEntry("tool:log")!.defaultParams).toEqual({
      message: "",
    });
    expect(getNodeCatalogEntry("ai:llm_agent")!.defaultParams).toEqual({
      instruction: "",
    });
    expect(getNodeCatalogEntry("human:task")!.defaultParams).toEqual({
      description: "",
    });
    expect(getNodeCatalogEntry("nested:subworkflow")!.defaultParams).toEqual({
      subworkflow: { type: "template", template_id: "" },
    });
  });

  test("getDefaultNode returns a legal unique id and independent object graphs", () => {
    const a = getDefaultNode("data:assign");
    const b = getDefaultNode("data:assign");

    expect(a.id).toMatch(/^n_[0-9a-f]{8}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe("data:assign");
    expect(a.params).toEqual({ value: null });
    expect(a.capability_groups).toEqual([]);
    expect(a.agent_name).toBeNull();

    // Mutating the returned node must not affect the catalog or siblings.
    a.params.value = 42;
    a.inputs.push({ name: "extra", type: "data" });
    expect(getNodeCatalogEntry("data:assign")!.defaultParams).toEqual({
      value: null,
    });
    expect(getDefaultNode("data:assign").inputs).toHaveLength(1);
  });

  test("getDefaultNode on an unknown type fails loudly", () => {
    expect(() => getDefaultNode("nope:missing" as NodeType)).toThrow(
      /Unknown workflow node type/,
    );
  });

  test("NODE_CATEGORIES lists the 6 categories with labels", () => {
    expect(NODE_CATEGORIES).toHaveLength(6);
    expect(NODE_CATEGORIES.map((c) => c.id)).toEqual([
      "flow",
      "data",
      "tool",
      "ai",
      "human",
      "subworkflow",
    ]);
    for (const category of NODE_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
    }
  });

  test("makeNodeId produces n_ + 8 hex chars", () => {
    expect(makeNodeId()).toMatch(/^n_[0-9a-f]{8}$/);
  });
});
