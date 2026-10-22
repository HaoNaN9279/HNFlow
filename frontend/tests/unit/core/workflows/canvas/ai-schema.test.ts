import { describe, expect, test } from "@rstest/core";

import {
  COMMON_AI_SCHEMA_FIELDS,
  aiSchemaFieldRef,
  aiSchemaReferenceList,
  emptyAiSchema,
  parseAiSchema,
  validateAiSchema,
  type AiSchema,
} from "@/core/workflows/canvas/ai-schema";

describe("AI Result Schema", () => {
  test("empty schema uses the fixed common contract", () => {
    expect(emptyAiSchema()).toEqual({
      version: 1,
      max_repairs: 1,
      custom_fields: [],
    });
    expect(COMMON_AI_SCHEMA_FIELDS.map((field) => field.name)).toEqual([
      "summary",
      "status",
      "content",
      "artifacts",
      "metadata",
      "error",
    ]);
  });

  test("parses custom fields and clamps repairs", () => {
    const schema = parseAiSchema({
      version: 1,
      max_repairs: 99,
      custom_fields: [
        {
          name: "decision",
          type: "enum",
          required: true,
          description: "Review decision",
          enum_values: ["approve", "reject"],
        },
      ],
    });
    expect(schema.max_repairs).toBe(5);
    expect(schema.custom_fields[0]?.name).toBe("decision");
    expect(schema.custom_fields[0]?.enum_values).toEqual(["approve", "reject"]);
  });

  test("legacy payload falls back to an empty schema", () => {
    expect(parseAiSchema({ fields: { summary: "data" } })).toEqual(
      emptyAiSchema(),
    );
  });

  test("validates names, reserved fields, and enum values", () => {
    const schema: AiSchema = {
      version: 1,
      max_repairs: 1,
      custom_fields: [
        {
          name: "summary",
          type: "data",
          required: false,
          description: "",
          enum_values: [],
        },
        {
          name: "Bad Name",
          type: "enum",
          required: false,
          description: "",
          enum_values: [],
        },
      ],
    };
    const errors = validateAiSchema(schema);
    expect(errors.get(0)?.name).toBe("reserved");
    expect(errors.get(1)?.name).toBe("invalid");
    expect(errors.get(1)?.enumValues).toBe("required");
  });

  test("builds uniform template references", () => {
    const schema: AiSchema = {
      version: 1,
      max_repairs: 1,
      custom_fields: [
        {
          name: "decision",
          type: "data",
          required: false,
          description: "",
          enum_values: [],
        },
      ],
    };
    expect(aiSchemaFieldRef("decision")).toBe("[schema.custom.decision]");
    expect(aiSchemaReferenceList(schema)).toContain("[schema.summary]");
    expect(aiSchemaReferenceList(schema)).toContain("[schema.custom.decision]");
  });
});
