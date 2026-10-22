/**
 * AI Result Schema v1 shared by the canvas schema editor and AI node helpers.
 *
 * Common fields are fixed by HNFlow; users only edit `custom_fields`.
 */

export const AI_SCHEMA_VERSION = 1 as const;

export const AI_SCHEMA_FIELD_TYPES = [
  "data",
  "number",
  "array",
  "record",
  "bool",
  "enum",
] as const;
export type AiSchemaFieldType = (typeof AI_SCHEMA_FIELD_TYPES)[number];

export const COMMON_AI_SCHEMA_FIELDS = [
  { name: "summary", type: "data", required: true },
  { name: "status", type: "enum", required: true },
  { name: "content", type: "data", required: true },
  { name: "artifacts", type: "array", required: false },
  { name: "metadata", type: "record", required: false },
  { name: "error", type: "record", required: false },
] as const;

export type AiSchemaField = {
  name: string;
  type: AiSchemaFieldType;
  required: boolean;
  description: string;
  enum_values: string[];
};

export type AiSchema = {
  version: typeof AI_SCHEMA_VERSION;
  max_repairs: number;
  custom_fields: AiSchemaField[];
};

export const AI_SCHEMA_FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const AI_SCHEMA_MAX_FIELDS = 32;
export const AI_SCHEMA_MAX_REPAIRS = 5;

const RESERVED_FIELD_NAMES = new Set([
  ...COMMON_AI_SCHEMA_FIELDS.map((field) => field.name),
  "protocol",
  "source_node",
  "run_id",
  "custom",
]);

export function emptyAiSchema(): AiSchema {
  return { version: AI_SCHEMA_VERSION, max_repairs: 1, custom_fields: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeField(raw: unknown): AiSchemaField | null {
  if (!isRecord(raw)) {
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name : "";
  const type =
    typeof raw.type === "string" &&
    (AI_SCHEMA_FIELD_TYPES as readonly string[]).includes(raw.type)
      ? (raw.type as AiSchemaFieldType)
      : "data";
  const enumValues = Array.isArray(raw.enum_values)
    ? raw.enum_values.map((item) => String(item))
    : [];
  return {
    name,
    type,
    required: raw.required === true,
    description: typeof raw.description === "string" ? raw.description : "",
    enum_values: enumValues,
  };
}

/** Normalize persisted params; malformed/legacy payloads fall back to empty. */
export function parseAiSchema(value: unknown): AiSchema {
  if (!isRecord(value) || value.version !== AI_SCHEMA_VERSION) {
    return emptyAiSchema();
  }
  const rawFields = Array.isArray(value.custom_fields)
    ? value.custom_fields
    : [];
  const maxRepairs =
    typeof value.max_repairs === "number" && Number.isFinite(value.max_repairs)
      ? Math.max(
          0,
          Math.min(AI_SCHEMA_MAX_REPAIRS, Math.round(value.max_repairs)),
        )
      : 1;
  return {
    version: AI_SCHEMA_VERSION,
    max_repairs: maxRepairs,
    custom_fields: rawFields
      .map(normalizeField)
      .filter((field): field is AiSchemaField => field !== null),
  };
}

export function newAiSchemaField(index: number): AiSchemaField {
  const base = `field_${index + 1}`;
  return {
    name: base,
    type: "data",
    required: false,
    description: "",
    enum_values: [],
  };
}

export function aiSchemaFieldRef(name: string): string {
  return `[schema.custom.${name}]`;
}

export function aiSchemaCommonRef(name: string): string {
  return `[schema.${name}]`;
}

export type AiSchemaFieldErrors = {
  name?: "required" | "invalid" | "reserved" | "duplicate";
  enumValues?: "required";
  description?: "tooLong";
};

export function validateAiSchema(
  schema: AiSchema,
): Map<number, AiSchemaFieldErrors> {
  const errors = new Map<number, AiSchemaFieldErrors>();
  const seen = new Set<string>();
  schema.custom_fields.forEach((field, index) => {
    const fieldErrors: AiSchemaFieldErrors = {};
    if (!field.name.trim()) {
      fieldErrors.name = "required";
    } else if (!AI_SCHEMA_FIELD_NAME_RE.test(field.name)) {
      fieldErrors.name = "invalid";
    } else if (RESERVED_FIELD_NAMES.has(field.name)) {
      fieldErrors.name = "reserved";
    } else if (seen.has(field.name)) {
      fieldErrors.name = "duplicate";
    }
    if (field.type === "enum" && field.enum_values.length === 0) {
      fieldErrors.enumValues = "required";
    }
    if (field.description.length > 500) {
      fieldErrors.description = "tooLong";
    }
    seen.add(field.name);
    if (Object.keys(fieldErrors).length > 0) {
      errors.set(index, fieldErrors);
    }
  });
  return errors;
}

export function aiSchemaReferenceList(schema: AiSchema): string[] {
  return [
    ...COMMON_AI_SCHEMA_FIELDS.map((field) => aiSchemaCommonRef(field.name)),
    ...schema.custom_fields.map((field) => aiSchemaFieldRef(field.name)),
  ];
}
