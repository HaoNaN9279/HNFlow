// 原子节点单测：start / setVariable / ifElse / end / registry。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { endNode } from "../src/nodes/end.js";
import { ifElseNode, InvalidIfElseConditionError } from "../src/nodes/ifElse.js";
import {
  builtinNodes,
  DuplicateNodeTypeError,
  NodeRegistry,
  registry,
  UnknownNodeTypeError,
} from "../src/nodes/registry.js";
import { InvalidSetVariableParameterError, setVariableNode } from "../src/nodes/setVariable.js";
import { startNode } from "../src/nodes/start.js";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type, name: id, params, inputs: [], outputs: [] };
}

function createMockContext(node: Node, initial: Readonly<Record<string, unknown>> = {}): NodeExecutionContext {
  const store: Record<string, unknown> = { ...initial };
  return {
    node,
    workflowId: "test-wf",
    get(scope, key) {
      return store[`${scope}:${key}`];
    },
    set(scope, key, value) {
      store[`${scope}:${key}`] = value;
    },
    getByPath(path) {
      return store[path];
    },
    setByPath(path, value) {
      store[path] = value;
    },
    getAll(scope) {
      const result: Record<string, unknown> = {};
      const prefix = `${scope}:`;
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          result[key.slice(prefix.length)] = store[key];
        }
      }
      return result;
    },
    suspend() {
      throw new Error("suspend not implemented in test mock");
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

describe("start 节点", () => {
  test("execute 返回 global 快照", async () => {
    const node = makeNode("start", "start", {});
    const ctx = createMockContext(node, { "global:name": "hnflow", "global:tier": "core" });
    const result = await startNode.execute(ctx);
    expect(result["data"]).toEqual({ name: "hnflow", tier: "core" });
  });
});

describe("setVariable 节点", () => {
  test("静态值写入 target", async () => {
    const node = makeNode("sv", "setVariable", { target: "workflow:x", value: 42 });
    const ctx = createMockContext(node);
    await setVariableNode.execute(ctx);
    expect(ctx.getByPath("workflow:x")).toBe(42);
  });

  test("${global:x} 插值", async () => {
    const node = makeNode("sv", "setVariable", { target: "workflow:msg", value: "${global:x}" });
    const ctx = createMockContext(node, { "global:x": "hi" });
    await setVariableNode.execute(ctx);
    expect(ctx.getByPath("workflow:msg")).toBe("hi");
  });

  test("前缀${workflow:x}后缀 拼接", async () => {
    const node = makeNode("sv", "setVariable", {
      target: "workflow:msg",
      value: "pre-${workflow:mid}-post",
    });
    const ctx = createMockContext(node, { "workflow:mid": "MID" });
    await setVariableNode.execute(ctx);
    expect(ctx.getByPath("workflow:msg")).toBe("pre-MID-post");
  });

  test("非字符串原样写入", async () => {
    const node = makeNode("sv", "setVariable", { target: "workflow:n", value: 3.14 });
    const ctx = createMockContext(node);
    await setVariableNode.execute(ctx);
    expect(ctx.getByPath("workflow:n")).toBe(3.14);
  });

  test("缺少 target 抛 InvalidSetVariableParameterError", async () => {
    const node = makeNode("sv", "setVariable", { value: 1 });
    const ctx = createMockContext(node);
    await expect(setVariableNode.execute(ctx)).rejects.toThrow(InvalidSetVariableParameterError);
  });
});

describe("ifElse 节点", () => {
  test("global:age gt 18 → age=30 true=true false=false", async () => {
    const node = makeNode("if", "ifElse", {
      condition: { variable: "global:age", op: "gt", value: 18 },
    });
    const ctx = createMockContext(node, { "global:age": 30 });
    const result = await ifElseNode.execute(ctx);
    expect(result).toEqual({ true: true, false: false });
  });

  test("age=10 → true=false false=true", async () => {
    const node = makeNode("if", "ifElse", {
      condition: { variable: "global:age", op: "gt", value: 18 },
    });
    const ctx = createMockContext(node, { "global:age": 10 });
    const result = await ifElseNode.execute(ctx);
    expect(result).toEqual({ true: false, false: true });
  });

  test("eq 边界：\"30\" eq 30 → true", async () => {
    const node = makeNode("if", "ifElse", {
      condition: { variable: "workflow:v", op: "eq", value: 30 },
    });
    const ctx = createMockContext(node, { "workflow:v": "30" });
    const result = await ifElseNode.execute(ctx);
    expect(result).toEqual({ true: true, false: false });
  });

  test("ne 边界：\"a\" ne \"b\" → true", async () => {
    const node = makeNode("if", "ifElse", {
      condition: { variable: "workflow:v", op: "ne", value: "b" },
    });
    const ctx = createMockContext(node, { "workflow:v": "a" });
    const result = await ifElseNode.execute(ctx);
    expect(result).toEqual({ true: true, false: false });
  });

  test("非法 condition 抛 InvalidIfElseConditionError", async () => {
    const node = makeNode("if", "ifElse", { condition: "not-an-object" });
    const ctx = createMockContext(node);
    await expect(ifElseNode.execute(ctx)).rejects.toThrow(InvalidIfElseConditionError);
  });
});

describe("end 节点", () => {
  test("读 workflow:endInput 写 workflow:endResult", async () => {
    const node = makeNode("end", "end", {});
    const ctx = createMockContext(node, { "workflow:endInput": "payload" });
    await endNode.execute(ctx);
    expect(ctx.getByPath("workflow:endResult")).toBe("payload");
  });
});

describe("registry 注册表", () => {
  test("15 个内置节点已注册", () => {
    expect(registry.list()).toHaveLength(15);
    expect(registry.list()).toEqual(expect.arrayContaining(["start", "end", "ifElse", "setVariable"]));
  });

  test("重复注册抛 DuplicateNodeTypeError", () => {
    expect(() => registry.register(startNode)).toThrow(DuplicateNodeTypeError);
  });

  test("未注册类型 get 抛 UnknownNodeTypeError", () => {
    expect(() => registry.get("no-such-type")).toThrow(UnknownNodeTypeError);
  });

  test("新实例注册全部 builtinNodes 后可用", () => {
    const fresh = new NodeRegistry();
    for (const def of builtinNodes) fresh.register(def);
    expect(fresh.has("start")).toBe(true);
    expect(fresh.list()).toHaveLength(15);
  });
});
