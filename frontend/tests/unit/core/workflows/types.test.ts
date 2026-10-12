import { describe, expect, test } from "@rstest/core";

import {
  type CanvasMetadata,
  NODE_TYPES,
  PORT_TYPES,
} from "@/core/workflows/types";

describe("workflow type constants", () => {
  test("PORT_TYPES has exactly the 7 backend values", () => {
    expect(PORT_TYPES).toEqual([
      "data",
      "file",
      "bool",
      "enum",
      "number",
      "array",
      "record",
    ]);
  });

  test("NODE_TYPES has exactly the 19 backend values", () => {
    expect(NODE_TYPES).toEqual([
      "flow:start",
      "flow:end",
      "flow:if",
      "flow:switch",
      "flow:loop",
      "flow:parallel",
      "flow:wait",
      "data:assign",
      "data:convert",
      "data:file",
      "data:json",
      "data:regex",
      "tool:bash",
      "tool:http",
      "tool:notify",
      "tool:log",
      "ai:llm_agent",
      "human:task",
      "nested:subworkflow",
    ]);
  });

  test("NODE_TYPES covers 7 flow / 5 data / 4 tool categories plus AI, human, nested", () => {
    expect(NODE_TYPES).toHaveLength(19);
    expect(NODE_TYPES.filter((n) => n.startsWith("flow:"))).toHaveLength(7);
    expect(NODE_TYPES.filter((n) => n.startsWith("data:"))).toHaveLength(5);
    expect(NODE_TYPES.filter((n) => n.startsWith("tool:"))).toHaveLength(4);
  });

  test("CanvasMetadata holds optional node positions with x/y numbers", () => {
    const canvas: CanvasMetadata = {
      positions: { start: { x: 0, y: 10 }, end: { x: 400, y: 10 } },
    };
    expect(canvas.positions?.start).toEqual({ x: 0, y: 10 });
    expect(canvas.positions?.end).toEqual({ x: 400, y: 10 });
  });
});
