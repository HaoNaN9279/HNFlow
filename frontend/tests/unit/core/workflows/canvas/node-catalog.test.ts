import { describe, expect, test } from "@rstest/core";

import {
  NODE_CATEGORIES,
  getDefaultNode,
  getDefaultNodeName,
  getNodeCatalog,
  getNodeCatalogEntry,
  makeNodeId,
  normalizeNodeDisplayName,
} from "@/core/workflows/canvas/node-catalog";
import { NODE_TYPES, type NodeType } from "@/core/workflows/types";

describe("node catalog", () => {
  test("covers exactly the 34 backend node types", () => {
    const catalog = getNodeCatalog();
    expect(catalog).toHaveLength(34);
    expect(catalog.map((e) => e.type).sort()).toEqual([...NODE_TYPES].sort());
  });

  test("every entry has a label, description and category", () => {
    for (const entry of getNodeCatalog()) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect([
        "flow",
        "data",
        "tool",
        "ai",
        "app",
        "human",
        "verify",
        "subworkflow",
      ]).toContain(entry.category);
    }
  });

  test("category counts match the backend split (9 flow / 8 data / 5 tool / 4 app + singles)", () => {
    const byCategory = (category: string) =>
      getNodeCatalog().filter((e) => e.category === category).length;
    expect(byCategory("flow")).toBe(9);
    expect(byCategory("data")).toBe(9);
    expect(byCategory("tool")).toBe(5);
    expect(byCategory("ai")).toBe(3);
    expect(byCategory("app")).toBe(4);
    expect(byCategory("human")).toBe(2);
    expect(byCategory("verify")).toBe(1);
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
      "results",
      "last",
    ]);

    const file = getNodeCatalogEntry("data:file")!;
    expect(file.defaultInputs.map((p) => p.type)).toEqual(["file"]);
    expect(file.defaultOutputs.map((p) => p.type)).toEqual(["file"]);

    const asset = getNodeCatalogEntry("data:asset")!;
    expect(asset.defaultInputs.map((p) => p.name)).toEqual(["in"]);
    expect(asset.defaultInputs[0]).toMatchObject({
      name: "in",
      type: "data",
      required: false,
    });
    expect(asset.defaultOutputs.map((p) => p.name)).toEqual([
      "out",
      "asset",
      "assets",
    ]);
    expect(asset.defaultOutputs.map((p) => p.type)).toEqual([
      "data",
      "data",
      "array",
    ]);
  });

  test("ai:llm_agent declares optional template_prompt/continue_prompt input ports", () => {
    const ai = getNodeCatalogEntry("ai:llm_agent")!;
    expect(ai.defaultInputs.map((p) => p.name)).toEqual([
      "in",
      "capability_groups",
      "template_prompt",
      "continue_prompt",
      "input_schema",
      "output_schema",
      "spec",
    ]);
    expect(ai.defaultInputs[0]).toMatchObject({
      name: "in",
      type: "data",
      required: false,
    });
    expect(ai.defaultInputs[1]).toMatchObject({
      name: "capability_groups",
      type: "array",
      required: false,
    });
    for (const port of ai.defaultInputs.slice(2, 4)) {
      expect(port).toMatchObject({ type: "data", required: false });
      expect(typeof port.description).toBe("string");
    }
    expect(ai.defaultInputs[4]).toMatchObject({
      name: "input_schema",
      type: "record",
      required: false,
    });
    expect(ai.defaultInputs[5]).toMatchObject({
      name: "output_schema",
      type: "record",
      required: false,
    });
    expect(ai.defaultInputs[6]).toMatchObject({
      name: "spec",
      type: "spec",
      required: false,
    });
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
      task: "",
    });
    expect(getNodeCatalogEntry("data:schema")!.label).toBe("Schema");
    expect(getNodeCatalogEntry("data:convert")!.defaultParams).toEqual({
      to: "str",
    });
    expect(getNodeCatalogEntry("data:file")!.defaultParams).toEqual({
      operation: "read",
      path: "",
    });
    expect(getNodeCatalogEntry("data:asset")!.defaultParams).toEqual({
      operation: "inspect",
      path: "",
      hash: true,
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
    expect(getNodeCatalogEntry("ai:llm_agent")!.defaultParams).toEqual({});
    expect(getNodeCatalogEntry("human:task")!.defaultParams).toEqual({
      description: "",
    });
    expect(getNodeCatalogEntry("human:review")!.defaultParams).toEqual({
      instructions: "",
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
    expect(a.params).toEqual({ value: null, task: "" });
    expect(a.capability_groups).toEqual([]);
    expect(a.agent_name).toBeNull();

    // Mutating the returned node must not affect the catalog or siblings.
    a.params.value = 42;
    a.inputs.push({ name: "extra", type: "data" });
    expect(getNodeCatalogEntry("data:assign")!.defaultParams).toEqual({
      value: null,
      task: "",
    });
    expect(getDefaultNode("data:assign").inputs).toHaveLength(1);
  });

  test("getDefaultNode on an unknown type fails loudly", () => {
    expect(() => getDefaultNode("nope:missing" as NodeType)).toThrow(
      /Unknown workflow node type/,
    );
  });

  test("NODE_CATEGORIES lists the 8 categories with labels", () => {
    expect(NODE_CATEGORIES).toHaveLength(8);
    expect(NODE_CATEGORIES.map((c) => c.id)).toEqual([
      "flow",
      "data",
      "tool",
      "ai",
      "app",
      "human",
      "verify",
      "subworkflow",
    ]);
    for (const category of NODE_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
    }
  });

  test("app:* entries declare session in/out ports and app params", () => {
    const launch = getNodeCatalogEntry("app:launch")!;
    expect(launch.defaultInputs.map((p) => p.name)).toEqual(["in"]);
    expect(launch.defaultOutputs.map((p) => p.name)).toEqual([
      "session",
      "out",
    ]);
    expect(launch.defaultParams).toEqual({ app: "", mode: "launch" });

    const script = getNodeCatalogEntry("app:script")!;
    expect(script.defaultInputs.map((p) => p.name)).toEqual(["session", "in"]);
    expect(script.defaultParams).toEqual({ app: "", script: "" });

    const collect = getNodeCatalogEntry("app:collect")!;
    expect(collect.defaultOutputs.map((p) => p.type)).toEqual([
      "data",
      "file",
      "array",
    ]);
    expect(collect.defaultOutputs.map((p) => p.name)).toEqual([
      "session",
      "out",
      "assets",
    ]);
    expect(collect.defaultParams).toEqual({ app: "" });
  });

  test("makeNodeId produces n_ + 8 hex chars", () => {
    expect(makeNodeId()).toMatch(/^n_[0-9a-f]{8}$/);
  });

  test("custom display names trim, reject blanks and fall back to the default name", () => {
    expect(getDefaultNodeName("flow:start")).toBe("Start");
    expect(normalizeNodeDisplayName("flow:start", "Entry")).toBe("Entry");
    expect(normalizeNodeDisplayName("flow:start", "  Entry  ")).toBe("Entry");
    expect(normalizeNodeDisplayName("flow:start", "   ")).toBeUndefined();
    expect(normalizeNodeDisplayName("flow:start", "Start")).toBeUndefined();
  });
});
