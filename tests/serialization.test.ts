// 序列化 + 存储集成测试（AC1 + AC5）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { deserialize, fromJSON, serialize, toJSON } from "../src/serialization/index.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";

function makeNode(
  id: string,
  type: string,
  params: Readonly<Record<string, unknown>> = {},
): Node {
  const def = registry.get(type);
  return { id, type, name: `${type}:${id}`, params, inputs: def.inputs, outputs: def.outputs };
}

/** AC1：含 5 节点（start + setVariable + ifElse + setVariable + end）的完整工作流。 */
function buildWorkflow(): Workflow {
  return {
    id: "wf-5node",
    name: "五节点工作流",
    version: "0.1.0",
    globalVariables: { name: "hnflow", age: 30 },
    nodes: [
      makeNode("n1", "start"),
      makeNode("n2", "setVariable", { target: "workflow:msg", value: "${global:name}" }),
      makeNode("n3", "ifElse", { condition: { variable: "global:age", op: "gt", value: 18 } }),
      makeNode("n4", "setVariable", { target: "workflow:result", value: "adult" }),
      { ...makeNode("n5", "end"), position: { x: 10, y: 20 } },
    ],
    edges: [
      { id: "e1", sourceNodeId: "n1", sourcePortId: "data", targetNodeId: "n2", targetPortId: "in" },
      { id: "e2", sourceNodeId: "n2", sourcePortId: "out", targetNodeId: "n3", targetPortId: "in" },
      { id: "e3", sourceNodeId: "n3", sourcePortId: "true", targetNodeId: "n4", targetPortId: "in" },
      { id: "e4", sourceNodeId: "n4", sourcePortId: "out", targetNodeId: "n5", targetPortId: "in" },
    ],
  };
}

describe("AC1 序列化往返", () => {
  test("5 节点图 toJSON→JSON→fromJSON 逐字段深比较还原", () => {
    const workflow = buildWorkflow();
    const json = toJSON(workflow);
    const text = JSON.stringify(json);
    const parsed: unknown = JSON.parse(text);
    const restored = fromJSON(parsed);
    expect(restored).toEqual(workflow);
  });

  test("serialize/deserialize 往返还原", () => {
    const workflow = buildWorkflow();
    const restored = deserialize(serialize(workflow));
    expect(restored).toEqual(workflow);
  });

  test("损坏 JSON fromJSON 抛错且消息含路径", () => {
    expect(() => fromJSON({ nodes: 123 })).toThrow(/Invalid workflow JSON: .*nodes/);
  });

  test("非法文本 deserialize 抛错", () => {
    expect(() => deserialize("{ not valid json")).toThrow("Invalid workflow JSON text");
  });
});

describe("AC5 JSON 文件保存加载", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hnflow-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saveWorkflow 落盘 → loadWorkflow 还原相等", async () => {
    const filePath = join(tmpDir, "wf.json");
    const workflow = buildWorkflow();
    await saveWorkflow(filePath, workflow);
    expect(existsSync(filePath)).toBe(true);
    const loaded = await loadWorkflow(filePath);
    expect(loaded).toEqual(workflow);
  });

  test("覆盖保存为新值", async () => {
    const filePath = join(tmpDir, "wf.json");
    await saveWorkflow(filePath, buildWorkflow());
    const updated = { ...buildWorkflow(), name: "updated" };
    await saveWorkflow(filePath, updated);
    const loaded = await loadWorkflow(filePath);
    expect(loaded.name).toBe("updated");
  });

  test("loadWorkflow 不存在文件抛 ENOENT 友好错误", async () => {
    await expect(loadWorkflow(join(tmpDir, "missing.json"))).rejects.toThrow(/ENOENT/);
  });
});
