// 三级作用域上下文单测（AC4 支撑）。
import { describe, expect, test } from "bun:test";
import {
  InvalidKeyError,
  InvalidPathError,
  UnknownScopeError,
  WorkflowContext,
} from "../src/context/WorkflowContext.js";

describe("WorkflowContext 三级作用域", () => {
  test("global/workflow/node:foo 各 set/get", () => {
    const ctx = new WorkflowContext();
    ctx.set("global", "a", 1);
    ctx.set("workflow", "b", "two");
    ctx.set("node:foo", "c", true);
    expect(ctx.get("global", "a")).toBe(1);
    expect(ctx.get("workflow", "b")).toBe("two");
    expect(ctx.get("node:foo", "c")).toBe(true);
  });

  test("node 级隔离：node:foo 写值 node:bar 不可见", () => {
    const ctx = new WorkflowContext();
    ctx.set("node:foo", "x", 42);
    expect(ctx.get("node:bar", "x")).toBeUndefined();
  });

  test("未设置 key 返回 undefined", () => {
    const ctx = new WorkflowContext();
    expect(ctx.get("global", "missing")).toBeUndefined();
    expect(ctx.getByPath("workflow:missing")).toBeUndefined();
    expect(ctx.get("node:foo", "missing")).toBeUndefined();
  });

  test("未知 scope 抛错（get/set/getByPath）", () => {
    const ctx = new WorkflowContext();
    expect(() => ctx.get("bogus", "x")).toThrow(UnknownScopeError);
    expect(() => ctx.set("bogus", "x", 1)).toThrow(UnknownScopeError);
    expect(() => ctx.getByPath("bogus:x")).toThrow(UnknownScopeError);
    expect(() => ctx.setByPath("bogus:x", 1)).toThrow(UnknownScopeError);
    expect(() => ctx.get("node:", "x")).toThrow(UnknownScopeError);
  });

  test("无冒号路径抛错", () => {
    const ctx = new WorkflowContext();
    expect(() => ctx.getByPath("noColon")).toThrow(InvalidPathError);
    expect(() => ctx.setByPath("noColon", 1)).toThrow(InvalidPathError);
  });

  test("空 key 抛错", () => {
    const ctx = new WorkflowContext();
    expect(() => ctx.get("global", "")).toThrow(InvalidKeyError);
    expect(() => ctx.set("global", "", 1)).toThrow(InvalidKeyError);
    expect(() => ctx.getByPath("global:")).toThrow(InvalidKeyError);
  });

  test("getAll 返回作用域快照", () => {
    const ctx = new WorkflowContext();
    ctx.set("workflow", "a", 1);
    ctx.set("workflow", "b", 2);
    expect(ctx.getAll("workflow")).toEqual({ a: 1, b: 2 });
  });

  test("getSnapshot 结构正确", () => {
    const ctx = new WorkflowContext();
    ctx.set("global", "g", 1);
    ctx.set("workflow", "w", 2);
    ctx.set("node:foo", "c", 3);
    const snap = ctx.getSnapshot();
    expect(snap.global).toEqual({ g: 1 });
    expect(snap.workflow).toEqual({ w: 2 });
    expect(snap.node).toEqual({ "node:foo": { c: 3 } });
  });

  test("构造注入 globalVariables 可读", () => {
    const ctx = new WorkflowContext({ globalVariables: { seed: "value" } });
    expect(ctx.get("global", "seed")).toBe("value");
    expect(ctx.get("workflow", "seed")).toBeUndefined();
  });
});
