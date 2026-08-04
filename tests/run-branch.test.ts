// runBranch 并行分支 helper 单测：成功返回 { endResult, variables }（variables 含子图写入的 workflow 变量）、
// 失败/挂起错误转换、registryOverride 透传、idSuffix 隔离分支 workflowId。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { endNode } from "../src/nodes/end.js";
import { NodeRegistry, registry } from "../src/nodes/registry.js";
import { startNode } from "../src/nodes/start.js";
import {
  SubworkflowFailedError,
  SubworkflowWaitingError,
  runBranch,
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
    name: "并行分支",
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
  const path = join(TEMP_BASE, `hnflow-runbranch-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
});

describe("runBranch 成功执行", () => {
  test("返回 { endResult, variables } 且 variables 含子图写入的 workflow 变量", async () => {
    const sub: Workflow = {
      id: "sub-ok",
      name: "分支工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:branchVar", value: "branch-val" }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "final" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const ctx = makeCtx("parent-branch-ok", makeSubworkflowNode("br", sub));
    const result = await runBranch(ctx, sub, {});
    expect(result).toEqual({ endResult: "final", variables: { branchVar: "branch-val", endResult: "final", endInput: "final" } });
  });

  test("workflowVariables 传入值保留在 variables 中", async () => {
    const sub: Workflow = {
      id: "sub-seed",
      name: "分支工作流",
      version: "0.1.0",
      nodes: [makeNode("start", "start"), makeNode("end", "end")],
      edges: [],
    };
    const ctx = makeCtx("parent-branch-seed", makeSubworkflowNode("br", sub));
    const result = await runBranch(ctx, sub, { seed: "input-val" });
    expect(result.variables).toMatchObject({ seed: "input-val" });
  });
});

describe("runBranch 错误转换", () => {
  test("分支失败抛 SubworkflowFailedError", async () => {
    const sub: Workflow = {
      id: "sub-fail",
      name: "分支工作流",
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
    const ctx = makeCtx("parent-branch-fail", makeSubworkflowNode("br", sub));
    await expect(runBranch(ctx, sub, {})).rejects.toThrow(SubworkflowFailedError);
  });

  test("分支挂起抛 SubworkflowWaitingError 且携带任务", async () => {
    const sub: Workflow = {
      id: "sub-wait",
      name: "分支工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "分支审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const ctx = makeCtx("parent-branch-wait", makeSubworkflowNode("br", sub), store);
    try {
      await runBranch(ctx, sub, {});
      throw new Error("expected SubworkflowWaitingError");
    } catch (error) {
      expect(error).toBeInstanceOf(SubworkflowWaitingError);
      if (error instanceof SubworkflowWaitingError) {
        expect(error.task.workflowId).toBe("parent-branch-wait:br");
        expect(error.task.nodeId).toBe("human");
        expect(error.task.status).toBe("pending");
      }
    }
  });
});

describe("runBranch registryOverride 透传", () => {
  test("自定义节点类型经 override 注册可在分支中执行", async () => {
    const customEchoNode: INodeDefinition = {
      type: "customEcho",
      name: "自定义回显",
      inputs: [],
      outputs: [],
      async execute(ctx) {
        ctx.set("workflow", "echoed", "custom-ok");
        return {};
      },
    };
    const override = new NodeRegistry();
    override.register(startNode);
    override.register(endNode);
    override.register(customEchoNode);
    const sub: Workflow = {
      id: "sub-custom",
      name: "分支工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        { id: "echo", type: "customEcho", name: "回显", params: {}, inputs: [], outputs: [] },
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const ctx = makeCtx("parent-branch-custom", makeSubworkflowNode("br", sub));
    const result = await runBranch(ctx, sub, {}, override);
    expect(result.variables).toMatchObject({ echoed: "custom-ok" });
  });
});

describe("runBranch idSuffix 隔离 workflowId", () => {
  test("idSuffix 追加到分支 workflowId（humanTask 任务定位隔离）", async () => {
    const sub: Workflow = {
      id: "sub-suffix",
      name: "分支工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "分支审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const ctx = makeCtx("parent-branch-suffix", makeSubworkflowNode("br", sub), store);
    try {
      await runBranch(ctx, sub, {}, undefined, "#0");
      throw new Error("expected SubworkflowWaitingError");
    } catch (error) {
      expect(error).toBeInstanceOf(SubworkflowWaitingError);
      if (error instanceof SubworkflowWaitingError) {
        expect(error.task.workflowId).toBe("parent-branch-suffix:br#0");
      }
    }
  });

  test("已含冒号的子 workflowId 不被追加 idSuffix", async () => {
    const sub: Workflow = {
      id: "root:path-wf",
      name: "分支工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "分支审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const ctx = makeCtx("parent-branch-path", makeSubworkflowNode("br", sub), store);
    try {
      await runBranch(ctx, sub, {}, undefined, "#0");
      throw new Error("expected SubworkflowWaitingError");
    } catch (error) {
      expect(error).toBeInstanceOf(SubworkflowWaitingError);
      if (error instanceof SubworkflowWaitingError) {
        expect(error.task.workflowId).toBe("root:path-wf");
      }
    }
  });
});
