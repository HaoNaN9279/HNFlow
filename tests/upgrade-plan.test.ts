// 模板升级端口映射模块单测（T4 端口映射纯逻辑）：buildUpgradePlan / applyUpgradePlan。
// 覆盖：自动匹配、manual/断开、固定 out 保留、params.template 更新、无关字段不变、不可变性。
import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "../src/model/types.js";
import type { TemplateInterface } from "../src/templates/types.js";
import type { UpgradePlan } from "../src/templates/upgrade-plan.js";
import { applyUpgradePlan, buildUpgradePlan } from "../src/templates/upgrade-plan.js";

/** 构造 subworkflow 节点：默认固定 out 输出端口 + position + 可覆盖字段。 */
function makeNode(overrides: Partial<Node> = {}): Node {
  const node: Node = {
    id: "n-sub",
    type: "subworkflow",
    name: "子流程",
    params: { template: "demo@1.0.0" },
    inputs: [],
    outputs: [{ id: "out", name: "done", type: "boolean", direction: "out" }],
    position: { x: 10, y: 20 },
  };
  return { ...node, ...overrides };
}

/** 构造指向 node 输入端口 in_port 的边（source 侧固定为外部节点）。 */
function makeEdge(id: string, inPortId: string, targetNodeId: string): Edge {
  return { id, sourceNodeId: "n-src", sourcePortId: "p-src", targetNodeId, targetPortId: inPortId };
}

/** JSON 深拷贝快照（纯数据，可安全序列化）。 */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("buildUpgradePlan 自动匹配场景", () => {
  const node = makeNode({
    inputs: [
      { id: "in_title", name: "title", type: "any", direction: "in" },
      { id: "in_content", name: "content", type: "any", direction: "in" },
    ],
    outputs: [
      { id: "out", name: "done", type: "boolean", direction: "out" },
      { id: "out_result", name: "result", type: "any", direction: "out" },
    ],
  });
  const target: TemplateInterface = {
    inputs: ["title", "content", "author"],
    outputs: ["result", "report"],
  };
  const plan = buildUpgradePlan({ node, targetInterface: target, edges: [] });

  test("title/content/result 同名自动匹配", () => {
    expect(plan.autoMatched.map((m) => m.currentKey).sort()).toEqual(["content", "result", "title"]);
  });

  test("manual 为空", () => {
    expect(plan.manual).toHaveLength(0);
  });

  test("author 进 addedKeys(input)、report 进 addedKeys(output)", () => {
    expect(plan.addedKeys).toEqual([
      { kind: "input", key: "author" },
      { kind: "output", key: "report" },
    ]);
  });

  test("固定 out 不进入 mappings", () => {
    expect(plan.mappings.some((m) => m.currentKey === "out")).toBe(false);
  });

  test("auto 映射 matchedKey 与 currentKey 同名", () => {
    expect(plan.mappings.every((m) => m.auto && m.matchedKey === m.currentKey)).toBe(true);
  });
});

describe("手动映射与断开场景", () => {
  const node = makeNode({
    inputs: [{ id: "in_content", name: "content", type: "any", direction: "in" }],
  });
  const edge = makeEdge("e-content", "in_content", node.id);
  const target: TemplateInterface = { inputs: ["title"], outputs: [] };
  const plan = buildUpgradePlan({ node, targetInterface: target, edges: [edge] });

  test("content 进 manual 且 hasEdge=true", () => {
    expect(plan.manual).toHaveLength(1);
    const mapping = plan.manual[0];
    if (mapping === undefined) {
      throw new Error("manual 应恰有 1 项");
    }
    expect(mapping.kind).toBe("input");
    expect(mapping.currentKey).toBe("content");
    expect(mapping.auto).toBe(false);
    expect(mapping.matchedKey).toBeUndefined();
    expect(mapping.hasEdge).toBe(true);
  });

  test("提供 manualMappings 映射 → 重建为 in_title 且不断开", () => {
    const result = applyUpgradePlan({
      node,
      plan,
      templateName: "demo",
      targetVersion: "2.0.0",
      manualMappings: { content: "title" },
    });
    expect(result.node.inputs.some((p) => p.id === "in_title" && p.name === "title")).toBe(true);
    expect(result.node.inputs.some((p) => p.id === "in_content")).toBe(false);
    expect(result.manualDisconnected).toEqual([]);
    expect(result.edgesToRemove).toEqual([]);
  });

  test("不提供映射 → content 断开、关联边进 edgesToRemove", () => {
    const result = applyUpgradePlan({
      node,
      plan,
      templateName: "demo",
      targetVersion: "2.0.0",
      manualMappings: {},
    });
    expect(result.node.inputs.some((p) => p.id === "in_content")).toBe(false);
    expect(result.manualDisconnected).toEqual(["content"]);
    expect(result.edgesToRemove).toEqual(["e-content"]);
  });
});

describe("固定 out 端口保留", () => {
  const node = makeNode({
    outputs: [
      { id: "out", name: "done", type: "boolean", direction: "out" },
      { id: "out_result", name: "result", type: "any", direction: "out" },
    ],
  });
  const target: TemplateInterface = { inputs: [], outputs: ["result"] };
  const plan = buildUpgradePlan({ node, targetInterface: target, edges: [] });

  test("重建后 outputs 含 id=out 且沿用 name/type", () => {
    const result = applyUpgradePlan({
      node,
      plan,
      templateName: "demo",
      targetVersion: "2.0.0",
      manualMappings: {},
    });
    const fixed = result.node.outputs.find((p) => p.id === "out");
    expect(fixed?.id).toBe("out");
    expect(fixed?.name).toBe("done");
    expect(fixed?.type).toBe("boolean");
    expect(fixed?.direction).toBe("out");
  });
});

describe("params.template 更新", () => {
  const node = makeNode();
  const target: TemplateInterface = { inputs: [], outputs: [] };
  const plan = buildUpgradePlan({ node, targetInterface: target, edges: [] });

  test("template 更新为 name@version 且保留其他 params", () => {
    const result = applyUpgradePlan({
      node,
      plan,
      templateName: "demo",
      targetVersion: "2.1.0",
      manualMappings: {},
    });
    expect(result.node.params.template).toBe("demo@2.1.0");
    expect(result.node.params).toEqual({ template: "demo@2.1.0" });
  });
});

describe("无关字段不变", () => {
  const node = makeNode({
    inputs: [{ id: "in_title", name: "title", type: "any", direction: "in" }],
    subworkflow: { id: "sw", name: "内部", version: "1.0.0", nodes: [], edges: [] },
  });
  const target: TemplateInterface = { inputs: ["title"], outputs: [] };
  const plan = buildUpgradePlan({ node, targetInterface: target, edges: [] });

  test("id/type/name/position/subworkflow 保持", () => {
    const result = applyUpgradePlan({
      node,
      plan,
      templateName: "demo",
      targetVersion: "2.0.0",
      manualMappings: {},
    });
    expect(result.node.id).toBe("n-sub");
    expect(result.node.type).toBe("subworkflow");
    expect(result.node.name).toBe("子流程");
    expect(result.node.position).toEqual({ x: 10, y: 20 });
    expect(result.node.subworkflow).toBe(node.subworkflow);
  });
});

describe("不可变性", () => {
  const node = makeNode({
    inputs: [{ id: "in_content", name: "content", type: "any", direction: "in" }],
  });
  const edge = makeEdge("e-content", "in_content", node.id);
  const target: TemplateInterface = { inputs: ["title"], outputs: [] };

  test("buildUpgradePlan 不修改输入", () => {
    const input = { node, targetInterface: target, edges: [edge] };
    const before = snapshot(input);
    buildUpgradePlan(input);
    expect(input).toEqual(before);
  });

  test("applyUpgradePlan 不修改 node 与 plan", () => {
    const plan = buildUpgradePlan({ node, targetInterface: target, edges: [edge] });
    const nodeBefore = snapshot(node);
    const planBefore = snapshot(plan as UpgradePlan);
    applyUpgradePlan({ node, plan, templateName: "demo", targetVersion: "2.0.0", manualMappings: {} });
    expect(node).toEqual(nodeBefore);
    expect(plan).toEqual(planBefore);
  });
});
