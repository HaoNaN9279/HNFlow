// parallel 节点测试：基础并发（AC3）、上下文隔离（AC2）、合并规则（replace/mergeArrays/errorOnConflict，AC1）、
// params 排除、失败聚合（ParallelBranchFailedError）、挂起透传与恢复（SubworkflowWaitingError + doneBranches）、
// 断点恢复跳过已完成分支、registry 计数（16）、参数校验。
// 恢复用例照 loop-recovery.test.ts 模式（SQLite 临时库 + buildEngineFromRunState/continueRun）；
// 其余用例照 loop-node.test.ts 模式（Engine + HumanTaskStore 临时文件）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import { buildEngineFromRunState, continueRun } from "../src/execution/resume.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { InvalidParallelParamsError, parallelNode } from "../src/nodes/parallel.js";
import {
  openDatabase,
  SqliteRunStateStore,
  type SqliteDatabase,
} from "../src/db/index.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";
const RECOVERY_BASE = join(TEMP_BASE, "parallel-recovery-test");

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeParallelNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("parallel");
  return { id, type: "parallel", name: "并行分支", params, inputs: def.inputs, outputs: def.outputs };
}

/** 分支：setVariable 写 endInput → end，endResult 为静态值。 */
function simpleBranch(branchId: string, endInput: unknown): Workflow {
  return {
    id: `branch-${branchId}`,
    name: branchId,
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", { target: "workflow:endInput", value: endInput }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** parent：start → par → end，par 输出 results 连 end（endResult = results 映射）。 */
function parentWorkflow(id: string, branches: readonly unknown[]): Workflow {
  return {
    id,
    name: "parent",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeParallelNode("par", { branches }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

describe("parallel 基础并发与结果", () => {
  test("两分支并发：results 映射 { b1, b2 }，endResult 透传", async () => {
    const wf = parentWorkflow("par-basic", [
      { id: "b1", workflow: simpleBranch("b1", "B1") },
      { id: "b2", workflow: simpleBranch("b2", "B2") },
    ]);
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["par"]).toBe("Success");
    expect(result.nodeOutputs["par"]?.["results"]).toEqual({ b1: "B1", b2: "B2" });
    expect(engine.getWorkflowVariable("endResult")).toEqual({ b1: "B1", b2: "B2" });
  });
});

describe("parallel 上下文隔离", () => {
  test("分支 A 改 x，分支 B 读 x 得父原值（互不污染）", async () => {
    const branchA: Workflow = {
      id: "iso-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:x", value: "from-A" }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const branchB: Workflow = {
      id: "iso-b",
      name: "b",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "${workflow:x}" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf: Workflow = {
      id: "par-iso",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: "parent-x" }),
        makeParallelNode("par", { branches: [{ id: "a", workflow: branchA }, { id: "b", workflow: branchB }] }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("success");
    // 分支 B 读到父原值（分支 A 的修改未污染）；分支 A 自身修改生效。
    expect(result.nodeOutputs["par"]?.["results"]).toEqual({ a: "A", b: "parent-x" });
  });
});

describe("parallel 合并规则", () => {
  test("replace：父 x=1 被分支覆盖为 2；分支新增 key y 写回父", async () => {
    const branchA: Workflow = {
      id: "merge-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:x", value: 2 }),
        makeNode("sv2", "setVariable", { target: "workflow:y", value: 99 }),
        makeNode("sv3", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf: Workflow = {
      id: "par-merge",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 1 }),
        makeParallelNode("par", { branches: [{ id: "a", workflow: branchA }] }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(engine.getWorkflowVariable("x")).toBe(2);
    expect(engine.getWorkflowVariable("y")).toBe(99);
  });

  test("排除 params：分支改写 workflow:params 整包不写回父", async () => {
    const branchA: Workflow = {
      id: "param-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:params", value: { hacked: true } }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf = parentWorkflow("par-param", [{ id: "a", workflow: branchA }]);
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(engine.getWorkflowVariable("params")).toBeUndefined();
  });

  test("mergeArrays：父 arr=[1]，分支 arr=[2,3] → [1,2,3]", async () => {
    const branchA: Workflow = {
      id: "arr-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:arr", value: [2, 3] }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf: Workflow = {
      id: "par-arr",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:arr", value: [1] }),
        makeParallelNode("par", {
          branches: [{ id: "a", workflow: branchA, merge: { mode: "mergeArrays" } }],
        }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(engine.getWorkflowVariable("arr")).toEqual([1, 2, 3]);
  });

  test("errorOnConflict：父已有 key 且分支修改 → ParallelMergeConflictError，节点 Failed", async () => {
    const branchA: Workflow = {
      id: "conflict-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:x", value: 2 }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf: Workflow = {
      id: "par-conflict",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 1 }),
        makeParallelNode("par", {
          branches: [{ id: "a", workflow: branchA, merge: { mode: "errorOnConflict" } }],
        }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(wf).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["par"]).toBe("Failed");
    expect(result.error).toContain("合并冲突");
  });

  test("errorOnConflict：分支新增 key（父无）允许合并", async () => {
    const branchA: Workflow = {
      id: "conflict-new-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:z", value: "new" }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf = parentWorkflow("par-conflict-new", [
      { id: "a", workflow: branchA, merge: { mode: "errorOnConflict" } },
    ]);
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(engine.getWorkflowVariable("z")).toBe("new");
  });
});

describe("parallel 失败聚合", () => {
  test("分支 b2 失败 → ParallelBranchFailedError 携带 branchId；分支 b1 结果不合并", async () => {
    const branchA: Workflow = {
      id: "fail-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:x", value: 2 }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    // 缺 target 的 setVariable：子引擎内抛 InvalidSetVariableParameterError → 分支失败。
    const branchB: Workflow = {
      id: "fail-b",
      name: "b",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("bad", "setVariable", { value: 1 }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf: Workflow = {
      id: "par-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:x", value: 1 }),
        makeParallelNode("par", { branches: [{ id: "b1", workflow: branchA }, { id: "b2", workflow: branchB }] }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["par"]).toBe("Failed");
    expect(result.error).toContain("b2");
    // 失败优先：b1 结果不合并，父 x 保持原值 1。
    expect(engine.getWorkflowVariable("x")).toBe(1);
  });
});

describe("parallel 挂起透传与恢复", () => {
  test("分支 b2 含 humanTask → 父 waiting；resume 后 b1 跳过（doneBranches）、b2 读 task_result 完成", async () => {
    const branchA: Workflow = {
      id: "wait-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const branchB: Workflow = {
      id: "wait-b",
      name: "b",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "并行分支审批" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "b1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const wf = parentWorkflow("par-wait", [
      { id: "b1", workflow: branchA },
      { id: "b2", workflow: branchB },
    ]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const fake = new FakeRunStateStore();
    const engine = new ExecutionEngine(wf, {
      runId: "par-wait-1",
      persist: true,
      runStateStore: fake,
      humanTaskStore: store,
    });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    // 分支命名空间：workflowId 含分支后缀（taskStartIndex 逐段回溯定位父 par 节点）。
    expect(task.nodeId).toBe("human");
    expect(task.workflowId).toBe("par-wait:par:b2");
    expect(await store.listPending()).toHaveLength(1);
    // 断点快照：b1 已完成（doneBranches 已记录），恢复时跳过不重复执行/合并。
    const snap = await fake.getById("par-wait-1");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    expect(snap.contextSnapshot.node["node:par"]?.["doneBranches"]).toEqual(["b1"]);

    // resume：parallel 重跑读 doneBranches 跳过 b1，b2 读 task_result 通过。
    const resumed = await engine.resume(task.id, "approve");
    expect(resumed.status).toBe("success");
    expect(resumed.nodeOutputs["par"]?.["results"]).toEqual({ b2: "approve" });
    expect(await store.listAll()).toHaveLength(1);
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe("parallel doneBranches 断点恢复", () => {
  test("构造断点（b1 已完成并入父、doneBranches=[b1]）：b1 跳过不重跑，b2 重跑并合并", async () => {
    const dbPath = nextDbPath("rec");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const branchA: Workflow = {
      id: "rec-a",
      name: "a",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:x", value: "B1" }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "A" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const branchB: Workflow = {
      id: "rec-b",
      name: "b",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv1", "setVariable", { target: "workflow:y", value: "B2" }),
        makeNode("sv2", "setVariable", { target: "workflow:endInput", value: "B" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const wf = parentWorkflow("par-rec", [
      { id: "b1", workflow: branchA },
      { id: "b2", workflow: branchB },
    ]);
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    // 断点：b1 已在中断前合并（x="pre-merged-b1"）+ doneBranches 记录，b2 未开始。
    const runState: RunState = {
      runId: "par-rec-1",
      workflowId: wf.id,
      workflow: wf,
      nodeStates: { start: "Success", par: "Idle", end: "Idle" },
      nodeOutputs: {},
      contextSnapshot: {
        global: {},
        workflow: { x: "pre-merged-b1" },
        node: { "node:par": { doneBranches: ["b1"] } },
      },
      status: "running",
      updatedAt: 1000,
    };
    await runStore.create(runState);

    const engine = buildEngineFromRunState(runState, { runStateStore: runStore });
    const r = await continueRun(engine, runState);
    expect(r.status).toBe("success");
    // b1 跳过（若重跑会覆盖 x 为 "B1"）：x 保持中断前合并值；b2 重跑合并 y。
    expect(engine.getWorkflowVariable("x")).toBe("pre-merged-b1");
    expect(engine.getWorkflowVariable("y")).toBe("B2");
    expect(r.nodeOutputs["par"]?.["results"]).toEqual({ b2: "B" });
  });
});

describe("parallel 参数校验", () => {
  test("branches 缺失/空数组 → InvalidParallelParamsError", async () => {
    const node = makeParallelNode("par", { branches: [] });
    await expect(parallelNode.execute(createMockContext(node))).rejects.toThrow(InvalidParallelParamsError);
  });

  test("id 重复 → InvalidParallelParamsError", async () => {
    const node = makeParallelNode("par", {
      branches: [
        { id: "dup", workflow: simpleBranch("dup", "x") },
        { id: "dup", workflow: simpleBranch("dup", "y") },
      ],
    });
    await expect(parallelNode.execute(createMockContext(node))).rejects.toThrow(InvalidParallelParamsError);
  });

  test("workflow 非 Workflow → InvalidParallelParamsError", async () => {
    const node = makeParallelNode("par", { branches: [{ id: "a", workflow: { id: "bad" } }] });
    await expect(parallelNode.execute(createMockContext(node))).rejects.toThrow(InvalidParallelParamsError);
  });

  test("merge.mode 非法 → InvalidParallelParamsError", async () => {
    const node = makeParallelNode("par", {
      branches: [{ id: "a", workflow: simpleBranch("a", "x"), merge: { mode: "concat" } }],
    });
    await expect(parallelNode.execute(createMockContext(node))).rejects.toThrow(InvalidParallelParamsError);
  });
});

describe("parallel registry", () => {
  test("parallel 已注册且内置节点总数 16（独立 registry 实例）", () => {
    const reg = new NodeRegistry();
    for (const def of builtinNodes) reg.register(def);
    expect(reg.has("parallel")).toBe(true);
    expect(reg.list()).toHaveLength(16);
  });
});

/** mock ctx：仅用于参数校验直测（parse 阶段抛错，不触达分支执行）。 */
function createMockContext(node: Node): NodeExecutionContext {
  return {
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
}

/** 内存版 RunState store：进度持久化断言用。 */
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
  const path = join(TEMP_BASE, `hnflow-parallel-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

let dbCounter = 0;
function nextDbPath(prefix: string): string {
  return join(RECOVERY_BASE, `${prefix}-${Date.now()}-${dbCounter++}.db`);
}

const sharedDbs: SqliteDatabase[] = [];

beforeAll(async () => {
  await mkdir(RECOVERY_BASE, { recursive: true });
});

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
  for (const db of sharedDbs) db.close();
  await rmRetry(RECOVERY_BASE);
}, 30000);

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

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
