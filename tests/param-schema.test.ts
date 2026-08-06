// 参数 schema 元数据测试（v0.4.0 T1）：16 内置节点 paramsSchema 覆盖与结构合法性。
import { describe, expect, test } from "bun:test";
import type { INodeDefinition, ParamField } from "../src/execution/types.js";
import { aiNode } from "../src/nodes/ai.js";
import { commandNode } from "../src/nodes/command.js";
import { httpNode } from "../src/nodes/http.js";
import { builtinNodes } from "../src/nodes/registry.js";

/** 明确允许缺省 paramsSchema 的节点：无用户参数或子图经画布编辑（不暴露参数面板）。 */
const SCHEMA_OPTIONAL_TYPES: ReadonlySet<string> = new Set(["start", "end", "tryCatch", "finally"]);

/** 取节点 schema；缺省时抛错（fail 测试），避免在测试里使用非空断言。 */
function schemaOf(def: INodeDefinition): readonly ParamField[] {
  const schema = def.paramsSchema;
  if (schema === undefined) {
    throw new Error(`节点 ${def.type} 应有 paramsSchema`);
  }
  return schema;
}

describe("内置节点 paramsSchema 覆盖", () => {
  test("内置节点共 16 个，缺省清单外节点均有非空 paramsSchema", () => {
    expect(builtinNodes).toHaveLength(16);
    for (const def of builtinNodes) {
      if (SCHEMA_OPTIONAL_TYPES.has(def.type)) continue;
      const schema = schemaOf(def);
      expect(schema.length).toBeGreaterThan(0);
    }
  });
});

describe("paramsSchema 结构合法性", () => {
  for (const def of builtinNodes) {
    if (SCHEMA_OPTIONAL_TYPES.has(def.type)) continue;
    test(`节点 ${def.type} schema 结构合法`, () => {
      const schema = schemaOf(def);
      const keys = schema.map((field) => field.key);
      // key 唯一
      expect(new Set(keys).size).toBe(keys.length);
      for (const field of schema) {
        // label 非空
        expect(field.label.trim().length).toBeGreaterThan(0);
        // required 字段不得携带 default（必填值须由用户提供，缺省值仅用于可选字段）
        if (field.required === true) {
          expect(field.default).toBeUndefined();
        }
        // select 类型必有非空 options
        if (field.type === "select") {
          const options = field.options;
          expect(options).toBeDefined();
          expect((options ?? []).length).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe("schema key 与 parseParams 读取字段一致（抽查）", () => {
  test("http 节点 schema 覆盖 parseParams 读取字段", () => {
    const keys = new Set(schemaOf(httpNode).map((field) => field.key));
    for (const expected of ["url", "method", "timeoutMs"]) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  test("command 节点 schema 覆盖 parseParams 读取字段", () => {
    const keys = new Set(schemaOf(commandNode).map((field) => field.key));
    for (const expected of ["command", "timeoutMs", "failOnNonZero"]) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  test("ai 节点 schema 覆盖 parseParams 读取字段", () => {
    const keys = new Set(schemaOf(aiNode).map((field) => field.key));
    for (const expected of ["inputMessages", "systemPrompt", "stream"]) {
      expect(keys.has(expected)).toBe(true);
    }
  });
});

// 类型层面：ParamField 构造合法性由 tsc 覆盖（strict + exactOptionalPropertyTypes）。
// 此处放一个覆盖全可选字段形态的样本，确保字段缺失/提供两种写法均可编译。
const SAMPLE_FIELDS: readonly ParamField[] = [
  { key: "url", label: "URL", type: "string", required: true },
  { key: "method", label: "请求方法", type: "select", default: "GET", options: [{ label: "GET", value: "GET" }] },
  { key: "body", label: "请求体", type: "textarea", description: "字符串原样发送" },
];

test("ParamField 样本可构造", () => {
  expect(SAMPLE_FIELDS.map((field) => field.key)).toEqual(["url", "method", "body"]);
});
