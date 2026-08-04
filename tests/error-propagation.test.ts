// 错误传播规则测试（AC4）：tryCatch/subworkflow/finally 组合下的失败捕获、嵌套冒泡、
// onError 触发语义、错误路径 Skipped 语义。
// 覆盖场景：
//   1. subworkflow 失败被 tryCatch 捕获（catch 有值、节点 Success、catch 链执行）
//   2. tryCatch 内嵌两层 subworkflow，最内层失败冒泡到最外层 catch
//   3. tryCatch 嵌套 tryCatch：内层捕获自己的失败，外层 catch 不触发、外层 out 正常
//   4. onError 两种语义：不含 tryCatch 时节点失败触发；tryCatch 吞错后不触发（子图错误在子引擎内）
//   5. finally 与 tryCatch 组合：捕获失败后 finally 仍执行，整体 success
//   6. 错误路径 Skipped 语义：out 链 Skipped、catch 链 Success、catch 链之后节点正常执行
import { describe, expect, test } from "bun:test";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeTryCatchNode(id: string, body: Workflow): Node {
  return {
    id,
    type: "tryCatch",
    name: "异常捕获",
    params: { body },
    inputs: [],
    outputs: [
      { id: "out", name: "结果", type: "any", direction: "out" },
      { id: "catch", name: "错误", type: "any", direction: "out" },
    ],
  };
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

/** 失败子图：command 非零退出 → 子引擎 failed。 */
function failingSubgraph(id: string): Workflow {
  return {
    id,
    name: id,
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("cmd", "command", {
        command: "node",
        args: ["-e", "process.exit(1)"],
        failOnNonZero: true,
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** 失败 try 体：直接 command 非零退出。 */
function failingBody(): Workflow {
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
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** 清理体：标记 → end，经 finally out 端口断言已执行。 */
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

/** try 体：start → subworkflow(subgraph) → end（subgraph 失败即 body 失败）。 */
function subBody(subgraph: Workflow): Workflow {
  return {
    id: "body-sub",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sub", "subworkflow", { subworkflow: subgraph }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "b1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** catch 端口输出对象：message 必有，detail 可序列化时附带。 */
function asCatch(value: unknown): { message?: unknown; detail?: unknown } {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected catch 端口输出对象");
  }
  return value as { message?: unknown; detail?: unknown };
}

describe("tryCatch 捕获 subworkflow 失败", () => {
  test("body 内 subworkflow 子图失败 → catch 有值、try Success、catch 链执行", async () => {
    const parent: Workflow = {
      id: "ac4-sub-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", subBody(failingSubgraph("sub-graph"))),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "catch-branch" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    // subworkflow 失败被吞 → catch 端口携带 SubworkflowFailedError。
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("子工作流执行失败");
    expect(caught.detail).toBeDefined();
    // catch 链执行：错误被吞后流程继续。
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("catchVal")).toBe("catch-branch");
  });
});

describe("tryCatch 内嵌 subworkflow 失败冒泡", () => {
  test("两层 subworkflow，最内层失败 → 冒泡到最外层 tryCatch catch", async () => {
    // 嵌套：try → body → sub(subgraph1) → sub(subgraph2 失败)。
    // subgraph2 失败逐层抛 SubworkflowFailedError，最终被最外层 tryCatch 捕获。
    const parent: Workflow = {
      id: "ac4-deep-bubble",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", subBody(subBody(failingSubgraph("sub-graph-2")))),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "bubbled" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("子工作流执行失败");
    expect(caught.detail).toBeDefined();
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("catchVal")).toBe("bubbled");
  });
});

describe("tryCatch 嵌套 tryCatch", () => {
  test("内层捕获自己的失败，外层 catch 不触发、外层 out 正常", async () => {
    // outerBody 全部节点无入边，按拓扑序执行：start → inner(tryCatch) → sv → end。
    // inner 吞掉 body 失败 → inner Success（子引擎无 Failed 节点）→ sv/end 照常执行 →
    // outerBody 子引擎 success → outer 走 out 分支（catch 不触发）、out 为 endResult。
    const outerBody: Workflow = {
      id: "body-outer",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("inner", failingBody()),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "outer-ok" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "ac4-nested",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("outer", outerBody),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "outer", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    // 外层：内层吞错后子图成功 → catch 不触发、out 正常。
    expect(result.nodeStates["outer"]).toBe("Success");
    expect(result.nodeOutputs["outer"]?.["catch"]).toBeUndefined();
    expect(result.nodeOutputs["outer"]?.["out"]).toBe("outer-ok");
    // 内层捕获失败由「子引擎成功 + 外层走 out 分支」隐含证明：
    // 若内层未吞错，outerBody 子引擎会 failed，外层 catch 将触发、out 不会为 outer-ok。
  });
});

describe("onError 触发语义", () => {
  test("不含 tryCatch：subworkflow 失败 → onError 触发一次、整体 failed", async () => {
    const parent: Workflow = {
      id: "ac4-onerror-bare",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sub", "subworkflow", { subworkflow: failingSubgraph("sub-graph") }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const errors: Error[] = [];
    const result = await new ExecutionEngine(parent, {
      events: { onError: (error) => errors.push(error) },
    }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["sub"]).toBe("Failed");
    // subworkflow 失败冒泡为父引擎节点失败 → 父引擎 onError 触发。
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("子工作流执行失败");
  });

  test("tryCatch 吞错：同 subworkflow 失败被吞 → onError 不触发、整体 success", async () => {
    const parent: Workflow = {
      id: "ac4-onerror-swallow",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", subBody(failingSubgraph("sub-graph"))),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const errors: Error[] = [];
    const result = await new ExecutionEngine(parent, {
      events: { onError: (error) => errors.push(error) },
    }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    // 子图错误在子引擎内被吞，tryCatch 节点本身 Success → 父引擎 onError 不触发。
    expect(errors).toHaveLength(0);
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("子工作流执行失败");
  });
});

describe("finally 与 tryCatch 组合", () => {
  test("tryCatch 捕获失败 → 后续 finally 仍执行，整体 success（成功语义）", async () => {
    const parent: Workflow = {
      id: "ac4-try-finally",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", failingBody()),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "f", targetPortId: "in" },
        { id: "e2", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    expect(result.nodeStates["end"]).toBe("Success");
  });

  test("tryCatch body 失败被吞 → finally 执行，其后普通节点继续", async () => {
    const parent: Workflow = {
      id: "ac4-try-finally-downstream",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", failingBody()),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("after", "setVariable", { target: "workflow:afterVal", value: "ran" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "f", targetPortId: "in" },
        { id: "e2", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "after", targetPortId: "in" },
        { id: "e3", sourceNodeId: "after", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    expect(result.nodeStates["after"]).toBe("Success");
    expect(engine.getWorkflowVariable("afterVal")).toBe("ran");
    expect(result.nodeStates["end"]).toBe("Success");
  });
});

describe("错误路径 Skipped 语义", () => {
  test("tryCatch 失败：out 链 Skipped、catch 链 Success、catch 链之后节点正常执行", async () => {
    const parent: Workflow = {
      id: "ac4-skipped-path",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", failingBody()),
        makeNode("outSv", "setVariable", { target: "workflow:outVal", value: "out-branch" }),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "catch-branch" }),
        makeNode("afterSv", "setVariable", { target: "workflow:afterVal", value: "after-branch" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "out", targetNodeId: "outSv", targetPortId: "in" },
        { id: "e2", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
        { id: "e3", sourceNodeId: "catchSv", sourcePortId: "out", targetNodeId: "afterSv", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    // 未激活的 out 分支：Skipped，不写变量。
    expect(result.nodeStates["outSv"]).toBe("Skipped");
    expect(engine.getWorkflowVariable("outVal")).toBeUndefined();
    // 激活的 catch 分支：Success，链路继续。
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("catchVal")).toBe("catch-branch");
    expect(result.nodeStates["afterSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("afterVal")).toBe("after-branch");
  });
});
