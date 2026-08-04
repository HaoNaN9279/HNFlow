// tryCatch 节点测试：成功/失败分支、下游激活互斥、非法 params、挂起透传、嵌套捕获。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { InvalidTryCatchParamsError, tryCatchNode } from "../src/nodes/tryCatch.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

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

// 每个测试独立 store 文件，afterAll 统一清理。
const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-trycatch-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
});

function expectWaiting(result: { status: string; waitingTask?: HumanTask }): HumanTask {
  if (result.status !== "waiting") {
    throw new Error(`expected waiting status, got: ${result.status}`);
  }
  const task = result.waitingTask;
  if (task === undefined) {
    throw new Error("expected waitingTask in result");
  }
  return task;
}

/** try 体：setVariable 写 endInput → end，endResult 为 value。 */
function successBody(value: unknown): Workflow {
  return {
    id: "body-ok",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", { target: "workflow:endInput", value }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** try 体：command 非零退出 → 子引擎失败。 */
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

describe("tryCatch 分支执行", () => {
  test("body 成功：out 有值、catch undefined、节点 Success", async () => {
    const parent: Workflow = {
      id: "parent-ok",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", successBody("ok-value")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(result.nodeOutputs["try"]?.["out"]).toBe("ok-value");
    expect(result.nodeOutputs["try"]?.["catch"]).toBeUndefined();
  });

  test("body 失败：catch 有值含 message、out undefined、节点 Success（吞错是容器正常行为）", async () => {
    const parent: Workflow = {
      id: "parent-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", failingBody()),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(result.nodeOutputs["try"]?.["out"]).toBeUndefined();
    const caught = result.nodeOutputs["try"]?.["catch"];
    if (typeof caught !== "object" || caught === null) {
      throw new Error("expected catch 端口输出对象");
    }
    const record = caught as { message?: unknown; detail?: unknown };
    expect(typeof record.message).toBe("string");
    expect(String(record.message)).toContain("子工作流执行失败");
  });
});

describe("tryCatch 下游激活互斥", () => {
  test("body 失败：out 链 Skipped、catch 链 Success", async () => {
    const parent: Workflow = {
      id: "parent-mutex-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", failingBody()),
        makeNode("outSv", "setVariable", { target: "workflow:outVal", value: "out-branch" }),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "catch-branch" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "out", targetNodeId: "outSv", targetPortId: "in" },
        { id: "e2", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(result.nodeStates["outSv"]).toBe("Skipped");
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("outVal")).toBeUndefined();
    expect(engine.getWorkflowVariable("catchVal")).toBe("catch-branch");
  });

  test("body 成功：out 链 Success、catch 链 Skipped", async () => {
    const parent: Workflow = {
      id: "parent-mutex-ok",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", successBody("ok-value")),
        makeNode("outSv", "setVariable", { target: "workflow:outVal", value: "out-branch" }),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "catch-branch" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "out", targetNodeId: "outSv", targetPortId: "in" },
        { id: "e2", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(result.nodeStates["outSv"]).toBe("Success");
    expect(result.nodeStates["catchSv"]).toBe("Skipped");
    expect(engine.getWorkflowVariable("outVal")).toBe("out-branch");
    expect(engine.getWorkflowVariable("catchVal")).toBeUndefined();
  });
});

describe("tryCatch 非法 params", () => {
  test("params.body 非 Workflow → 抛 InvalidTryCatchParamsError", async () => {
    const node = makeTryCatchNode("try", { id: "not-wf", name: "x", version: "0.1.0", nodes: [], edges: [] });
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
    await expect(tryCatchNode.execute(ctx)).rejects.toThrow(InvalidTryCatchParamsError);
  });
});

describe("tryCatch 挂起透传", () => {
  test("body humanTask 挂起 → 父 waiting、任务数=1、workflowId 带路径；resume 后 out 返回", async () => {
    const body: Workflow = {
      id: "body-wait",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "子图审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-wait",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", body),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "try", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(parent, { humanTaskStore: store });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    // 路径标识：父id:子节点id。
    expect(task.workflowId).toBe("parent-wait:try");
    expect(task.nodeId).toBe("human");
    // findPending 复用：透传不重复创建，共 1 个任务。
    expect(await store.listPending()).toHaveLength(1);

    const resumed = await engine.resume(task.id, "ok");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeOutputs["try"]?.["out"]).toBe("ok");
    // 任务流转 completed，无残留 pending。
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe("tryCatch 嵌套捕获", () => {
  test("body 内 subworkflow 失败 → tryCatch 捕获", async () => {
    const inner: Workflow = {
      id: "inner-fail",
      name: "inner",
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
    const body: Workflow = {
      id: "body-nest",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sub", "subworkflow", { subworkflow: inner }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "b1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-nest",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", body),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    const caught = result.nodeOutputs["try"]?.["catch"];
    if (typeof caught !== "object" || caught === null) {
      throw new Error("expected catch 端口输出对象");
    }
    const record = caught as { message?: unknown; detail?: unknown };
    expect(String(record.message)).toContain("子工作流执行失败");
    expect(record.detail).toBeDefined();
  });
});
