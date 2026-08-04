// loop 节点测试：items 解析（数组/次数/变量路径）、迭代注入、结果收集、
// 超限/非法参数、body 挂起透传（任务复用）、进度持久化。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { HumanTask } from "../src/human/types.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import {
  InvalidLoopParamsError,
  LoopIterationLimitError,
  loopNode,
} from "../src/nodes/loop.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeLoopNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("loop");
  return { id, type: "loop", name: "循环", params, inputs: def.inputs, outputs: def.outputs };
}

/** body：setVariable 插值 loopIndex/loopItem → endInput，endResult 为组合字符串。 */
function interpolateBody(): Workflow {
  return {
    id: "loop-body",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", {
        target: "workflow:endInput",
        value: "idx-${workflow:loopIndex}-item-${workflow:loopItem}",
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** parent：start → loop → end，loop 输出 results 连 end（endResult = results 数组）。 */
function parentWorkflow(loopId: string, loopParams: Readonly<Record<string, unknown>>, id: string): Workflow {
  return {
    id,
    name: "parent",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeLoopNode(loopId, loopParams),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: loopId, sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

describe("loop items 解析与迭代", () => {
  test("数组 items：按元素迭代，loopIndex/loopItem 注入生效", async () => {
    const wf = parentWorkflow("loop", { items: ["a", "b", "c"], body: interpolateBody() }, "loop-array");
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["loop"]).toBe("Success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-a",
      "idx-1-item-b",
      "idx-2-item-c",
    ]);
  });

  test("次数 items（number）：n 次迭代，loopItem 为下标", async () => {
    const wf = parentWorkflow("loop", { items: 3, body: interpolateBody() }, "loop-count");
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-0",
      "idx-1-item-1",
      "idx-2-item-2",
    ]);
  });

  test("变量路径 items：读 workflow 变量数组", async () => {
    const wf: Workflow = {
      id: "loop-path",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:itemList", value: ["x", "y"] }),
        makeLoopNode("loop", { items: "workflow:itemList", body: interpolateBody() }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e2", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-x",
      "idx-1-item-y",
    ]);
  });

  test("空数组：0 次迭代，results 空数组", async () => {
    const wf = parentWorkflow("loop", { items: [], body: interpolateBody() }, "loop-empty");
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([]);
  });

  test("次数 0/负数：视为空数组", async () => {
    const wf = parentWorkflow("loop", { items: 0, body: interpolateBody() }, "loop-zero");
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([]);
  });
});

describe("loop 结果收集", () => {
  test("results 数组含各迭代 endResult 且透传 end 链", async () => {
    const wf = parentWorkflow("loop", { items: [10, 20, 30], body: interpolateBody() }, "loop-collect");
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-10",
      "idx-1-item-20",
      "idx-2-item-30",
    ]);
    // results 数组透传 end 链为 endResult。
    expect(engine.getWorkflowVariable("endResult")).toEqual([
      "idx-0-item-10",
      "idx-1-item-20",
      "idx-2-item-30",
    ]);
  });
});

describe("loop 超限与非法参数", () => {
  test("items 长度超 maxIterations → LoopIterationLimitError，节点 Failed", async () => {
    const wf = parentWorkflow(
      "loop",
      { items: ["a", "b", "c", "d"], body: interpolateBody(), maxIterations: 3 },
      "loop-limit",
    );
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["loop"]).toBe("Failed");
    expect(result.error).toContain("迭代次数超限");
  });

  test("items 超限直测：execute 抛 LoopIterationLimitError", async () => {
    const node = makeLoopNode("loop", { items: [1, 2, 3], body: interpolateBody(), maxIterations: 2 });
    const ctx: NodeExecutionContext = {
      node,
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
    await expect(loopNode.execute(ctx)).rejects.toThrow(LoopIterationLimitError);
  });

  test("number items 超 maxIterations（生成前拦截）→ LoopIterationLimitError", async () => {
    const wf = parentWorkflow(
      "loop",
      { items: 10001, body: interpolateBody() },
      "loop-limit-count",
    );
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("迭代次数超限");
  });

  test("items 类型非法（boolean）→ InvalidLoopParamsError，节点 Failed", async () => {
    const wf = parentWorkflow("loop", { items: true, body: interpolateBody() }, "loop-bad-items");
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["loop"]).toBe("Failed");
    expect(result.error).toContain("invalid loop params");
  });

  test("items 变量路径不存在 → InvalidLoopParamsError，节点 Failed", async () => {
    const wf = parentWorkflow("loop", { items: "workflow:missing", body: interpolateBody() }, "loop-missing");
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["loop"]).toBe("Failed");
    expect(result.error).toContain("invalid loop items");
  });

  test("body 非 Workflow → InvalidLoopParamsError（mock ctx 直测）", async () => {
    const node = makeLoopNode("loop", { items: [1], body: { id: "bad" } });
    const ctx: NodeExecutionContext = {
      node,
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
    await expect(loopNode.execute(ctx)).rejects.toThrow(InvalidLoopParamsError);
  });
});

describe("loop body 挂起透传", () => {
  test("body humanTask 挂起 → 父 waiting、workflowId 带路径；resume 后 results 完整", async () => {
    const body: Workflow = {
      id: "loop-body-wait",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "循环内审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "b1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const wf = parentWorkflow("loop", { items: ["a", "b"], body }, "loop-wait");
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(wf, { humanTaskStore: store });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    // 路径标识：父id:loop节点id（taskStartIndex 回指父图 loop 节点）。
    expect(task.workflowId).toBe("loop-wait:loop");
    expect(task.nodeId).toBe("human");
    expect(await store.listPending()).toHaveLength(1);

    // resume：loop 重跑读进度跳迭代 → body 子引擎透传 task_result → 不重复创建任务。
    const resumed = await engine.resume(task.id, "ok");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeOutputs["loop"]?.["results"]).toEqual(["ok", "ok"]);
    expect(await store.listAll()).toHaveLength(1);
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe("loop 进度持久化", () => {
  test("persist=true：执行后 contextSnapshot 含 node:<loopId>:loopProgress = items.length", async () => {
    const fake = new FakeRunStateStore();
    const wf = parentWorkflow("loop", { items: ["a", "b", "c"], body: interpolateBody() }, "loop-progress");
    const engine = new ExecutionEngine(wf, {
      runId: "loop-progress-1",
      persist: true,
      runStateStore: fake,
    });
    const result = await engine.run();
    expect(result.status).toBe("success");
    const snap = await fake.getById("loop-progress-1");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    expect(snap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(3);
  });

  test("挂起中断：进度先于 body 执行写入（loopProgress = 挂起迭代下标）", async () => {
    const fake = new FakeRunStateStore();
    const body: Workflow = {
      id: "loop-body-progress-wait",
      name: "body",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "b1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const wf = parentWorkflow("loop", { items: ["a", "b", "c"], body }, "loop-progress-wait");
    const humanStore = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(wf, {
      runId: "loop-progress-wait-1",
      persist: true,
      runStateStore: fake,
      humanTaskStore: humanStore,
    });
    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const snap = await fake.getById("loop-progress-wait-1");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    // 进度 = 挂起迭代下标（执行前已写入，resume 后可跳迭代重跑）。
    expect(snap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(0);
    expect(snap.status).toBe("waiting");
  });
});

/** 内存版 RunState store：持久化断言用。 */
class FakeRunStateStore implements RunStateStoreLike {
  private readonly states = new Map<string, RunState>();

  async create(run: RunState): Promise<void> {
    this.states.set(run.runId, run);
  }

  async createIfAbsent(run: RunState): Promise<boolean> {
    const conflict = run.idempotencyKey === undefined
      ? this.states.has(run.runId)
      : [...this.states.values()].some((existing) =>
          existing.runId === run.runId || (existing.workflowId === run.workflowId && existing.idempotencyKey === run.idempotencyKey),
        );
    if (conflict) {
      return false;
    }
    this.states.set(run.runId, run);
    return true;
  }

  async update(run: RunState): Promise<void> {
    this.states.set(run.runId, run);
  }

  async getById(runId: string): Promise<RunState | undefined> {
    return this.states.get(runId);
  }

  async list(): Promise<RunState[]> {
    return [...this.states.values()];
  }

  async listByWorkflow(workflowId: string): Promise<RunState[]> {
    return [...this.states.values()].filter((run) => run.workflowId === workflowId);
  }
}

const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-loop-${Date.now()}-${fileCounter++}.json`);
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
