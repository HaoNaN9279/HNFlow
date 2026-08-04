// runSubgraph 公共 helper 单测：成功返回 endResult、失败/挂起/深度/非法子图错误转换、humanTaskStore 透传复用。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import {
  InvalidSubworkflowParamsError,
  MAX_SUBWORKFLOW_DEPTH,
  SubworkflowDepthError,
  SubworkflowFailedError,
  SubworkflowWaitingError,
  runSubgraph,
} from "../src/nodes/subgraph-exec.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeSubworkflowNode(id: string, subWorkflow: Workflow): Node {
  return {
    id,
    type: "subworkflow",
    name: "子工作流",
    params: { subworkflow: subWorkflow },
    inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

function makeCtx(workflowId: string, node: Node, humanTaskStore?: HumanTaskStore): NodeExecutionContext {
  return {
    node,
    workflowId,
    ...(humanTaskStore === undefined ? {} : { humanTaskStore }),
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
}

// 每个测试独立 store 文件，afterAll 统一清理。
const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-subgxec-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
});

describe("runSubgraph 成功执行", () => {
  test("子图 endInput → 返回 { endResult }", async () => {
    const sub: Workflow = {
      id: "sub-ok",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "final" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const ctx = makeCtx("parent-ok", makeSubworkflowNode("sub", sub));
    const result = await runSubgraph(ctx, sub, {});
    expect(result).toEqual({ endResult: "final" });
  });
});

describe("runSubgraph 错误转换", () => {
  test("子图失败抛 SubworkflowFailedError", async () => {
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
    const ctx = makeCtx("parent-fail", makeSubworkflowNode("sub", sub));
    await expect(runSubgraph(ctx, sub, {})).rejects.toThrow(SubworkflowFailedError);
  });

  test("子图挂起抛 SubworkflowWaitingError 且携带任务（workflowId 带路径）", async () => {
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
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const ctx = makeCtx("parent-wait", makeSubworkflowNode("sub", sub), store);
    try {
      await runSubgraph(ctx, sub, {});
      throw new Error("expected SubworkflowWaitingError");
    } catch (error) {
      expect(error).toBeInstanceOf(SubworkflowWaitingError);
      if (error instanceof SubworkflowWaitingError) {
        expect(error.task.workflowId).toBe("parent-wait:sub");
        expect(error.task.nodeId).toBe("human");
        expect(error.task.status).toBe("pending");
      }
    }
  });

  test("深度超限抛 SubworkflowDepthError", async () => {
    const sub: Workflow = {
      id: "sub-depth",
      name: "子工作流",
      version: "0.1.0",
      nodes: [makeNode("start", "start"), makeNode("end", "end")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const deepId = Array.from({ length: MAX_SUBWORKFLOW_DEPTH }, (_, i) => `wf${i}`).join(":");
    const ctx = makeCtx(deepId, makeSubworkflowNode("sub", sub));
    await expect(runSubgraph(ctx, sub, {})).rejects.toThrow(SubworkflowDepthError);
  });

  test("非法子图（边引用不存在节点）抛 InvalidSubworkflowParamsError", async () => {
    const bad: Workflow = {
      id: "sub-bad",
      name: "子工作流",
      version: "0.1.0",
      nodes: [makeNode("start", "start"), makeNode("end", "end")],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ghost", targetPortId: "in" },
      ],
    };
    const ctx = makeCtx("parent-bad", makeSubworkflowNode("sub", bad));
    await expect(runSubgraph(ctx, bad, {})).rejects.toThrow(InvalidSubworkflowParamsError);
  });
});

describe("runSubgraph humanTaskStore 透传", () => {
  test("子图 humanTask 挂起复用任务：同一 store 两次执行只创建 1 个任务", async () => {
    const sub: Workflow = {
      id: "sub-reuse",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "复用审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const ctx = makeCtx("parent-reuse", makeSubworkflowNode("sub", sub), store);
    await expect(runSubgraph(ctx, sub, {})).rejects.toThrow(SubworkflowWaitingError);
    await expect(runSubgraph(ctx, sub, {})).rejects.toThrow(SubworkflowWaitingError);
    expect(await store.listPending()).toHaveLength(1);
  });
});
