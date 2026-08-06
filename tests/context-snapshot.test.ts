// Engine.contextSnapshot 测试：三层上下文快照（global/workflow/node）暴露、
// 快照独立深拷贝、构造后 run 前空三层。
import { describe, expect, test } from "bun:test";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → sv1（写 workflow:msg）→ sv2（写 node:sv2:local）→ end 线性链。 */
function makeSnapshotWorkflow(globalVariables?: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "snapshot-wf",
    name: "snapshot",
    version: "0.1.0",
    ...(globalVariables === undefined ? {} : { globalVariables }),
    nodes: [
      makeNode("start", "start"),
      makeNode("sv1", "setVariable", { target: "workflow:msg", value: "hello" }),
      makeNode("sv2", "setVariable", { target: "node:sv2:local", value: "nested-value" }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "sv1", targetPortId: "in" },
      { id: "e2", sourceNodeId: "sv1", sourcePortId: "out", targetNodeId: "sv2", targetPortId: "in" },
      { id: "e3", sourceNodeId: "sv2", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

describe("Engine.contextSnapshot", () => {
  test("run 后返回三层完整快照（global/workflow/node）", async () => {
    const workflow = makeSnapshotWorkflow({ env: "test", nested: { flag: true } });
    const engine = new ExecutionEngine(workflow);
    const result = await engine.run();
    expect(result.status).toBe("success");

    const snap = engine.contextSnapshot;
    expect(snap.global).toEqual({ env: "test", nested: { flag: true } });
    expect(snap.workflow).toEqual({ msg: "hello" });
    // node 层 key 为完整作用域标识 node:<id>，值来自节点作用域写入。
    expect(snap.node).toEqual({ "node:sv2": { local: "nested-value" } });
  });

  test("快照独立深拷贝：修改返回快照不影响引擎内部", async () => {
    const engine = new ExecutionEngine(makeSnapshotWorkflow({ env: "test" }));
    await engine.run();

    const snap1 = engine.contextSnapshot;
    snap1.global["env"] = "tampered";
    snap1.workflow["msg"] = "tampered";
    const nodeScope = snap1.node["node:sv2"];
    if (nodeScope === undefined) throw new Error("snapshot missing node:sv2 scope");
    nodeScope["local"] = "tampered";

    // 再取一次：引擎内部值不受修改影响。
    const snap2 = engine.contextSnapshot;
    expect(snap2.global).toEqual({ env: "test" });
    expect(snap2.workflow).toEqual({ msg: "hello" });
    expect(snap2.node).toEqual({ "node:sv2": { local: "nested-value" } });
  });

  test("构造后、run 前返回空三层", () => {
    const engine = new ExecutionEngine(makeSnapshotWorkflow());
    const before = engine.contextSnapshot;
    expect(before.global).toEqual({});
    expect(before.workflow).toEqual({});
    expect(before.node).toEqual({});
  });
});
