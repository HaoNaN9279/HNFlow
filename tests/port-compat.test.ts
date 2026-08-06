// 端口类型兼容规则单测（T2）：4×4 = 16 种组合矩阵 + 不匹配消息。
import { describe, expect, test } from "bun:test";
import { describePortMismatch, isPortCompatible } from "../src/model/port-compat.js";

describe("isPortCompatible 4×4 矩阵", () => {
  // source = "string"
  test("string → string 兼容", () => {
    expect(isPortCompatible("string", "string")).toBe(true);
  });
  test("string → number 拒绝", () => {
    expect(isPortCompatible("string", "number")).toBe(false);
  });
  test("string → boolean 拒绝", () => {
    expect(isPortCompatible("string", "boolean")).toBe(false);
  });
  test("string → any 兼容（target=any）", () => {
    expect(isPortCompatible("string", "any")).toBe(true);
  });

  // source = "number"
  test("number → string 拒绝", () => {
    expect(isPortCompatible("number", "string")).toBe(false);
  });
  test("number → number 兼容", () => {
    expect(isPortCompatible("number", "number")).toBe(true);
  });
  test("number → boolean 拒绝", () => {
    expect(isPortCompatible("number", "boolean")).toBe(false);
  });
  test("number → any 兼容（target=any）", () => {
    expect(isPortCompatible("number", "any")).toBe(true);
  });

  // source = "boolean"
  test("boolean → string 拒绝", () => {
    expect(isPortCompatible("boolean", "string")).toBe(false);
  });
  test("boolean → number 拒绝", () => {
    expect(isPortCompatible("boolean", "number")).toBe(false);
  });
  test("boolean → boolean 兼容", () => {
    expect(isPortCompatible("boolean", "boolean")).toBe(true);
  });
  test("boolean → any 兼容（target=any）", () => {
    expect(isPortCompatible("boolean", "any")).toBe(true);
  });

  // source = "any"
  test("any → string 兼容（source=any）", () => {
    expect(isPortCompatible("any", "string")).toBe(true);
  });
  test("any → number 兼容（source=any）", () => {
    expect(isPortCompatible("any", "number")).toBe(true);
  });
  test("any → boolean 兼容（source=any）", () => {
    expect(isPortCompatible("any", "boolean")).toBe(true);
  });
  test("any → any 兼容", () => {
    expect(isPortCompatible("any", "any")).toBe(true);
  });
});

describe("describePortMismatch", () => {
  test("兼容组合返回 undefined", () => {
    expect(describePortMismatch("string", "string")).toBeUndefined();
    expect(describePortMismatch("number", "number")).toBeUndefined();
    expect(describePortMismatch("boolean", "boolean")).toBeUndefined();
    expect(describePortMismatch("any", "number")).toBeUndefined();
    expect(describePortMismatch("string", "any")).toBeUndefined();
    expect(describePortMismatch("any", "any")).toBeUndefined();
  });

  test("不兼容组合返回中文错误消息", () => {
    expect(describePortMismatch("number", "string")).toBe("端口类型不兼容：number → string");
    expect(describePortMismatch("string", "number")).toBe("端口类型不兼容：string → number");
    expect(describePortMismatch("boolean", "number")).toBe("端口类型不兼容：boolean → number");
  });

  test("消息顺序为 source → target", () => {
    const message = describePortMismatch("number", "boolean");
    expect(message).not.toBeUndefined();
    expect(message).toBe("端口类型不兼容：number → boolean");
  });
});
