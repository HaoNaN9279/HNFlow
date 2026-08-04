// finally 节点测试（引擎级为主，finally 语义依赖引擎调度）：
// 成功路径、失败后清理链激活（核心 AC2）、多 finally、清理失败传播、下游 Skipped、非法 params。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { finallyNode, InvalidFinallyParamsError } from "../src/nodes/finallyNode.js";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeFinallyNode(id: string, body: Workflow): Node {
  return {
    id,
    type: "finally",
    name: "收尾清理",
    params: { body },
    inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

/** 失败节点：command 非零退出 → 上游 Failed。 */
function boomNode(id: string): Node {
  return makeNode(id, "command", {
    command: "node",
    args: ["-e", "process.exit(7)"],
    failOnNonZero: true,
  });
}

/** finally 体：setVariable 标记 → end，endResult 即清理标记（经 out 端口可断言 finally 已执行）。 */
function cleanupBody(mark: string): Workflow {
  return {
    id: "body-clean",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", { target: "workflow:endInput", value: mark }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** finally 体：command 非零退出 → 清理失败。 */
function failingCleanupBody(): Workflow {
  return {
    id: "body-fail",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("cmd", "command", {
        command: "node",
        args: ["-e", "process.exit(1)"],
        failOnNonZero: true,
      }),
    ],
    edges: [],
  };
}

describe("finally 成功路径", () => {
  test("start → A(成功) → finallyF：finally 执行、标记生效、整体 success", async () => {
    const parent: Workflow = {
      id: "finally-ok",
      name: "parent",
      version: "0.1.0",
      globalVariables: { flag: true },
      nodes: [
        makeNode("start", "start"),
        makeNode("a", "ifElse", { condition: { variable: "global:flag", op: "eq", value: true } }),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "a", targetPortId: "in" },
        { id: "e2", sourceNodeId: "a", sourcePortId: "true", targetNodeId: "f", targetPortId: "in" },
        { id: "e3", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["a"]).toBe("Success");
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
  });
});

describe("finally 失败后清理链（核心 AC2）", () => {
  test("boom 失败 → finallyF 仍执行（标记生效）→ 最终 failed、主错误为 boom 的错误", async () => {
    const parent: Workflow = {
      id: "finally-ac2",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        boomNode("boom"),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "exitCode", targetNodeId: "f", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["boom"]).toBe("Failed");
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("boom(boom)");
    expect(result.error).toContain("command exited with code 7");
  });
});

describe("finally 多个清理节点", () => {
  test("boom 失败 → finallyF1 → finallyF2 都执行", async () => {
    const parent: Workflow = {
      id: "finally-multi",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        boomNode("boom"),
        makeFinallyNode("f1", cleanupBody("one")),
        makeFinallyNode("f2", cleanupBody("two")),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "exitCode", targetNodeId: "f1", targetPortId: "in" },
        { id: "e3", sourceNodeId: "f1", sourcePortId: "out", targetNodeId: "f2", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["boom"]).toBe("Failed");
    expect(result.nodeStates["f1"]).toBe("Success");
    expect(result.nodeStates["f2"]).toBe("Success");
    expect(result.nodeOutputs["f1"]?.["out"]).toBe("one");
    expect(result.nodeOutputs["f2"]?.["out"]).toBe("two");
  });
});

describe("finally 清理失败", () => {
  test("boom 失败 → finallyF(body 含失败节点) Failed → 最终 failed、主错误保留 boom 的错误", async () => {
    const parent: Workflow = {
      id: "finally-body-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        boomNode("boom"),
        makeFinallyNode("f", failingCleanupBody()),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "exitCode", targetNodeId: "f", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["boom"]).toBe("Failed");
    expect(result.nodeStates["f"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("boom(boom)");
    expect(result.error).not.toContain("子工作流执行失败");
  });

  test("finallyF Failed → 其下游普通节点 Skipped", async () => {
    const parent: Workflow = {
      id: "finally-downstream",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        boomNode("boom"),
        makeFinallyNode("f", failingCleanupBody()),
        makeNode("after", "setVariable", { target: "workflow:afterVal", value: "ran" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "boom", targetPortId: "in" },
        { id: "e2", sourceNodeId: "boom", sourcePortId: "exitCode", targetNodeId: "f", targetPortId: "in" },
        { id: "e3", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "after", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["f"]).toBe("Failed");
    expect(result.nodeStates["after"]).toBe("Skipped");
    expect(engine.getWorkflowVariable("afterVal")).toBeUndefined();
  });
});

describe("finally 非法 params", () => {
  test("params.body 非 Workflow → 抛 InvalidFinallyParamsError", async () => {
    const node = makeFinallyNode("f", { id: "not-wf", name: "x", version: "0.1.0", nodes: [], edges: [] });
    // 覆盖为非法值：缺 name 字段即非 Workflow。
    const badNode: Node = { ...node, params: { body: { id: "bad" } } };
    const ctx: NodeExecutionContext = {
      node: badNode,
      workflowId: "wf",
      get: () => undefined,
      set: () => {},
      getByPath: () => undefined,
      setByPath: () => {},
      getAll: () => ({}),
      suspend: () => {
        throw new Error("suspend not implemented in test mock");
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    await expect(finallyNode.execute(ctx)).rejects.toThrow(InvalidFinallyParamsError);
  });
});
