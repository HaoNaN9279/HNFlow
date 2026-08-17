import { describe, expect, test } from "@rstest/core";

import { parseWorkflowValidationErrors } from "@/core/workflows/errors";

describe("parseWorkflowValidationErrors", () => {
  test("parses an edge reference error into an edge entry with its index", () => {
    expect(
      parseWorkflowValidationErrors([
        "edge[3]: source node 'missing' not found",
      ]),
    ).toEqual([
      {
        type: "edge",
        id: "3",
        message: "edge[3]: source node 'missing' not found",
      },
    ]);
  });

  test("parses an edge port-type mismatch into an edge entry", () => {
    const message =
      "edge[3]: incompatible port types — 'A.out' is data but 'B.in' is file";
    expect(parseWorkflowValidationErrors([message])).toEqual([
      { type: "edge", id: "3", message },
    ]);
  });

  test("parses a node error into a node entry with the node id", () => {
    const message =
      "node 'A': param 'x' has non-JSON-compatible type set (allowed: str, int, float, bool, None, list, dict)";
    expect(parseWorkflowValidationErrors([message])).toEqual([
      { type: "node", id: "A", message },
    ]);
  });

  test("parses a structural error loc with a node index into a node entry", () => {
    expect(
      parseWorkflowValidationErrors([
        "定义结构非法: nodes.3.inputs.0.type — Input should be 'data', 'file', 'bool' or 'enum'",
      ]),
    ).toEqual([
      {
        type: "node",
        id: "3",
        message:
          "定义结构非法: nodes.3.inputs.0.type — Input should be 'data', 'file', 'bool' or 'enum'",
      },
    ]);
  });

  test("parses a structural error loc with an edge index into an edge entry", () => {
    expect(
      parseWorkflowValidationErrors([
        "定义结构非法: edges.1.condition — Input should be a valid string",
      ]),
    ).toEqual([
      {
        type: "edge",
        id: "1",
        message:
          "定义结构非法: edges.1.condition — Input should be a valid string",
      },
    ]);
  });

  test("degrades a structural loc without a node/edge index to unknown", () => {
    expect(
      parseWorkflowValidationErrors([
        "定义结构非法: id — String should match pattern '^[A-Za-z0-9_-]{1,64}$'",
      ]),
    ).toEqual([
      {
        type: "unknown",
        message:
          "定义结构非法: id — String should match pattern '^[A-Za-z0-9_-]{1,64}$'",
      },
    ]);
  });

  test("degrades an unrecognised format (e.g. dependency cycle) to unknown", () => {
    expect(parseWorkflowValidationErrors(["依赖环: A→B→C→A"])).toEqual([
      { type: "unknown", message: "依赖环: A→B→C→A" },
    ]);
  });

  test("returns an empty array for an empty errors list", () => {
    expect(parseWorkflowValidationErrors([])).toEqual([]);
  });

  test("returns an empty array for non-array input", () => {
    expect(parseWorkflowValidationErrors(undefined)).toEqual([]);
    expect(parseWorkflowValidationErrors(null)).toEqual([]);
    expect(parseWorkflowValidationErrors("edge[0]: x")).toEqual([]);
    expect(parseWorkflowValidationErrors({ errors: [] })).toEqual([]);
  });

  test("skips non-string entries without throwing", () => {
    expect(
      parseWorkflowValidationErrors([
        "edge[0]: source node 'a' not found",
        42,
        { message: "not a string" },
        null,
      ]),
    ).toEqual([
      { type: "edge", id: "0", message: "edge[0]: source node 'a' not found" },
    ]);
  });
});
