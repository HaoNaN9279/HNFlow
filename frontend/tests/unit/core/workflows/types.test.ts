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

  test("NODE_TYPES has exactly the 24 backend values", () => {
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
      "data:asset",
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

  test("NODE_TYPES covers 7 flow / 6 data / 4 tool / 4 app categories plus AI, human, nested", () => {
    expect(NODE_TYPES).toHaveLength(24);
    expect(NODE_TYPES.filter((n) => n.startsWith("flow:"))).toHaveLength(7);
    expect(NODE_TYPES.filter((n) => n.startsWith("data:"))).toHaveLength(6);
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
