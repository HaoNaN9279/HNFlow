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

  test("NODE_TYPES has exactly the 26 backend values", () => {
    expect(NODE_TYPES).toEqual([
      "flow:start",
      "flow:end",
      "flow:if",
      "flow:switch",
      "flow:loop",
      "flow:parallel",
      "flow:wait",
      "flow:try",
      "data:assign",
      "data:convert",
      "data:asset",
      "data:shared",
      "data:file",
      "data:json",
      "data:regex",
      "tool:bash",
      "tool:http",
      "tool:notify",
      "tool:log",
      "ai:llm_agent",
      "app:launch",
      "app:script",
      "app:wait",
      "app:collect",
      "human:task",
      "nested:subworkflow",
    ]);
  });

  test("NODE_TYPES covers 8 flow / 7 data / 4 tool / 4 app categories plus AI, human, nested", () => {
    expect(NODE_TYPES).toHaveLength(26);
    expect(NODE_TYPES.filter((n) => n.startsWith("flow:"))).toHaveLength(8);
    expect(NODE_TYPES.filter((n) => n.startsWith("data:"))).toHaveLength(7);
    expect(NODE_TYPES.filter((n) => n.startsWith("tool:"))).toHaveLength(4);
    expect(NODE_TYPES.filter((n) => n.startsWith("app:"))).toHaveLength(4);
  });

  test("CanvasMetadata holds optional node positions with x/y numbers", () => {
    const canvas: CanvasMetadata = {
      positions: { start: { x: 0, y: 10 }, end: { x: 400, y: 10 } },
    };
    expect(canvas.positions?.start).toEqual({ x: 0, y: 10 });
    expect(canvas.positions?.end).toEqual({ x: 400, y: 10 });
  });
});
