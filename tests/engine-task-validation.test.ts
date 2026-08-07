// Engine.resume 强制产物校验测试（v0.9.3）：requireResult=true 节点提交空结果拒绝；
// 非空放行；未开启 requireResult 空结果放行（兼容既有行为）；子图任务跳过校验（子图防御）。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { InvalidTaskResultError } from "../src/execution/errors.js";
import type { INodeDefinition } from "../src/execution/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";

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

/** 计数命令节点 + 定义（子图/普通链路共用）。 */
function countCmdNode(id: string): Node {
  return {
    id,
    type: "countCmd",
    name: id,
    params: {},
    inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
  };
}
function countCmdDef(state: { runs: number }): INodeDefinition {
  return {
    type: "countCmd",
    name: "countCmd",
    inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
    async execute() {
      state.runs++;
      return { count: state.runs };
    },
  };
}

/** 基于内置节点 + 自定义定义构建独立 registry。 */
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
}

/** start → human(requireResult) → countCmd → end 的强制校验工作流。 */
function strictHumanWorkflow(): Workflow {
  return {
    id: "strict-human-wf",
    name: "strict-human",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", { title: "强制审批", requireResult: true }),
      countCmdNode("cmd"),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "cmd", targetPortId: "in" },
      { id: "e3", sourceNodeId: "cmd", sourcePortId: "count", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-validate-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
});

/** 收窄 waiting 结果并返回任务。 */
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

describe("requireResult 强制产物校验", () => {
  test("空结果（undefined/空字符串/空对象）→ 抛 InvalidTaskResultError", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(strictHumanWorkflow(), {
      registry: makeRegistry([countCmdDef({ runs: 0 })]),
      humanTaskStore: store,
    });
    const result = await engine.run();
    const task = expectWaiting(result);

    // 校验失败不改变任务状态（complete 之前抛），同一 pending 任务可连续测三种空值。
    await expect(engine.resume(task.id, undefined)).rejects.toBeInstanceOf(InvalidTaskResultError);
    await expect(engine.resume(task.id, "")).rejects.toBeInstanceOf(InvalidTaskResultError);
    await expect(engine.resume(task.id, {})).rejects.toBeInstanceOf(InvalidTaskResultError);
    const stillPending = await store.getById(task.id);
    expect(stillPending?.status).toBe("pending");
  });

  test("非空结果放行 → success 且任务 completed", async () => {
    const cmdState = { runs: 0 };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(strictHumanWorkflow(), {
      registry: makeRegistry([countCmdDef(cmdState)]),
      humanTaskStore: store,
    });
    const result = await engine.run();
    const task = expectWaiting(result);

    const resumed = await engine.resume(task.id, "approve");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeStates["human"]).toBe("Success");
    expect(resumed.nodeStates["cmd"]).toBe("Success");
    expect(cmdState.runs).toBe(1);
    const completed = await store.getById(task.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("approve");
  });

  test("未开启 requireResult 时空结果放行（不抛，节点再次挂起）", async () => {
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const workflow: Workflow = {
      id: "lenient-human-wf",
      name: "lenient-human",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "宽松审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(workflow, { humanTaskStore: store });
    const result = await engine.run();
    const task = expectWaiting(result);

    // 空结果提交：不抛校验错误；human 节点读不到产物 → 再次挂起（等待有效输入）。
    const resumed = await engine.resume(task.id, undefined);
    expect(resumed.status).toBe("waiting");
  });
});

describe("子图防御（任务节点不在父引擎图内 → 跳过校验）", () => {
  test("父引擎 resume 子图 requireResult 任务空结果：不抛 InvalidTaskResultError", async () => {
    // 子图经 validateWorkflow 严格校验端口：human 节点无入端口，edges 仅连 human → end（照 resume.test.ts 子图模式）。
    const sub: Workflow = {
      id: "sub-validate",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "子图强制审批", requireResult: true }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "se1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-validate",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "pe1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(parent, { humanTaskStore: store });
    const r1 = await engine.run();
    const task = expectWaiting(r1);
    expect(task.nodeId).toBe("human"); // 子图内部节点 id：不在父引擎 #nodeById。

    // 空结果提交：子图防御跳过 requireResult 校验（父引擎无子图节点信息）。
    // 子图容器重跑时经 task_result:human 透传（subworkflow.ts），human 节点读到 "" 视为有效产物 → success。
    const r2 = await engine.resume(task.id, "");
    expect(r2.status).toBe("success");
    expect(r2.nodeOutputs["sub"]?.["out"]).toBe("");
    const completed = await store.getById(task.id);
    expect(completed?.status).toBe("completed");
  });
});
