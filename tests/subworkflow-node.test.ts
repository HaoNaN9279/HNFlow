// subworkflow 节点集成测试：参数传入、结果返回、多出口聚合、失败传播、挂起透传、深度限制、registry。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Port, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import {
  SubworkflowDepthError,
  subworkflowNode,
} from "../src/nodes/subworkflow.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeSubworkflowNode(
  id: string,
  subWorkflow: Workflow,
  inputPorts: readonly Port[] = [],
): Node {
  return {
    id,
    type: "subworkflow",
    name: "子工作流",
    params: { subworkflow: subWorkflow },
    inputs: [...inputPorts],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

// 每个测试独立 store 文件，afterAll 统一清理。
const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-subwf-${Date.now()}-${fileCounter++}.json`);
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

describe("subworkflow 参数传入与结果返回", () => {
  test("父 setVariable 写 workflow:params 值 → 子图插值读到 → endResult 返回父 out", async () => {
    const sub: Workflow = {
      id: "sub-params",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "${workflow:params:msg}" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "parent-params",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:params:msg", value: "hello parent" }),
        makeSubworkflowNode("sub", sub, [
          { id: "p_msg", name: "消息", type: "any", direction: "in", binding: "workflow:params:msg" },
        ]),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("hello parent");
  });

  test("子图 setVariable 写 endInput → end → 父 subworkflow out 端口值正确", async () => {
    const sub: Workflow = {
      id: "sub-result",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "final" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "parent-result",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("final");
  });

  test("子图 2 个无出边节点连 end → endResult 聚合数组 → 父 out 为数组", async () => {
    const sub: Workflow = {
      id: "sub-multi",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("ifA", "ifElse", { condition: { variable: "workflow:params:a", op: "eq", value: true } }),
        makeNode("ifB", "ifElse", { condition: { variable: "workflow:params:b", op: "eq", value: true } }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ifA", targetPortId: "in" },
        { id: "e2", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ifB", targetPortId: "in" },
        { id: "e3", sourceNodeId: "ifA", sourcePortId: "true", targetNodeId: "end", targetPortId: "in" },
        { id: "e4", sourceNodeId: "ifB", sourcePortId: "true", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-multi",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("svA", "setVariable", { target: "workflow:params:a", value: true }),
        makeNode("svB", "setVariable", { target: "workflow:params:b", value: true }),
        makeSubworkflowNode("sub", sub, [
          { id: "p_a", name: "a", type: "any", direction: "in", binding: "workflow:params:a" },
          { id: "p_b", name: "b", type: "any", direction: "in", binding: "workflow:params:b" },
        ]),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e5", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toEqual([true, true]);
  });
});

describe("subworkflow 失败传播", () => {
  test("子图 command 非零退出 → 父 run 返回 failed 且错误含 子工作流执行失败", async () => {
    const sub: Workflow = {
      id: "sub-fail",
      name: "子工作流",
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
    const parent: Workflow = {
      id: "parent-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["sub"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("子工作流执行失败");
  });
});

describe("subworkflow 挂起透传", () => {
  test("子图 humanTask 挂起 → 父 waiting、任务数=1、workflowId 带路径；resume 后父继续成功", async () => {
    const sub: Workflow = {
      id: "sub-wait",
      name: "子工作流",
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
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(parent, { humanTaskStore: store });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    // 路径标识：父id:子节点id。
    expect(task.workflowId).toBe("parent-wait:sub");
    expect(task.nodeId).toBe("human");
    // findPending 复用：透传不重复创建，共 1 个任务。
    expect(await store.listPending()).toHaveLength(1);

    const resumed = await engine.resume(task.id, "ok");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeOutputs["sub"]?.["out"]).toBe("ok");
    // 任务流转 completed，无残留 pending。
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe("subworkflow 深度限制", () => {
  const deepId = Array.from({ length: 10 }, (_, i) => `wf${i}`).join(":");

  test("execute 单测：workflowId 10 段 → 抛 SubworkflowDepthError", async () => {
    const sub: Workflow = {
      id: "sub-depth",
      name: "子工作流",
      version: "0.1.0",
      nodes: [makeNode("start", "start"), makeNode("end", "end")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const node = makeSubworkflowNode("sub", sub);
    const ctx: NodeExecutionContext = {
      node,
      workflowId: deepId,
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
    await expect(subworkflowNode.execute(ctx)).rejects.toThrow(SubworkflowDepthError);
  });

  test("集成：workflowId 10 段跑 subworkflow → run 返回 failed 且错误含 深度超限", async () => {
    const sub: Workflow = {
      id: "sub-depth",
      name: "子工作流",
      version: "0.1.0",
      nodes: [makeNode("start", "start"), makeNode("end", "end")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: deepId,
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["sub"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("深度超限");
  });
});

describe("subworkflow registry", () => {
  test("registry 已注册且内置节点总数 16", () => {
    expect(registry.has("subworkflow")).toBe(true);
    expect(registry.list()).toHaveLength(16);
  });
});