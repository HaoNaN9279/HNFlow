// loop 节点恢复 e2e 测试（T8）：结果持久化缺陷修复验收。
// 覆盖 AC3：失败中断恢复（已完成迭代结果保留）、迭代内挂起恢复（任务复用 + 用户输入不丢）、
// 断点恢复进度读取（restoreState → rebuildContext 后 loop 读 loopProgress/loopResults）。
// 说明：loop body 由子引擎执行，子引擎 registry 经容器节点透传（ctx.registry，T8 支持）；
// 测试自定义节点（boomIndex/waitGate）注册在独立 NodeRegistry（内置 + 自定义），不污染全局默认 registry。
// 使用 SQLite 临时库（照 tests/db-stores.test.ts 模式：afterAll timeout 30000 + rmRetry + Bun.gc(true)）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import {
  buildEngineFromRunState,
  continueRun,
  resumeTask,
} from "../src/execution/resume.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import {
  openDatabase,
  SqliteHumanTaskStore,
  SqliteRunStateStore,
  type SqliteDatabase,
} from "../src/db/index.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\loop-recovery-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows bun:sqlite 句柄释放依赖 GC，强制回收以解锁文件
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

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** 基于内置节点 + 自定义定义构建独立 registry（闭包计数器隔离，不污染全局默认 registry）。 */
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
}

function makeLoopNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("loop");
  return { id, type: "loop", name: "循环", params, inputs: def.inputs, outputs: def.outputs };
}

/** body：setVariable 插值 loopIndex/loopItem → endInput，endResult 为组合字符串（节点按根节点顺序执行，照 loop-node.test.ts）。 */
function interpolateBody(): Workflow {
  return {
    id: "loop-body-interp",
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

/** 失败中断 body：setVariable 生成 endResult；boomIndex 在第 failIndex 次迭代首次抛错（恢复重跑不再失败）。
 *  setVariable/boomIndex 均无端口依赖，按根节点顺序执行（照 loop-node.test.ts interpolateBody 模式）。 */
function boomBody(boomNode: Node): Workflow {
  return {
    id: "loop-body-boom",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", {
        target: "workflow:endInput",
        value: "idx-${workflow:loopIndex}-item-${workflow:loopItem}",
      }),
      boomNode,
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

function boomIndexNode(id: string, failIndex: number): Node {
  return {
    id,
    type: "boomIndex",
    name: id,
    params: { failIndex },
    inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
    outputs: [],
  };
}

/** 第 failIndex 次迭代首次执行抛错（后续执行成功）：失败中断恢复场景。 */
function boomIndexDef(state: { runs: number }): INodeDefinition {
  return {
    type: "boomIndex",
    name: "boomIndex",
    inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
    outputs: [],
    async execute(ctx) {
      state.runs++;
      const failIndex = ctx.node.params["failIndex"];
      const fail = typeof failIndex === "number" ? failIndex : -1;
      const index = ctx.getByPath("workflow:loopIndex");
      // 首次执行到 failIndex 迭代（第 failIndex+1 次 execute）时失败。
      if (typeof index === "number" && index === fail && state.runs === fail + 1) {
        throw new Error("boom exploded");
      }
      return {};
    },
  };
}

/** 挂起恢复 body：waitGate 在 loopIndex >= 1 且无人工产物时挂起（迭代 1 首次挂起）；resume 后 task_result 透传通过。 */
function waitBody(waitNode: Node): Workflow {
  return {
    id: "loop-body-wait",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      waitNode,
      makeNode("end", "end"),
    ],
    edges: [
      { id: "b2", sourceNodeId: waitNode.id, sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

function waitGateNode(id: string): Node {
  return {
    id,
    type: "waitGate",
    name: id,
    params: { title: "循环内审批" },
    inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
    outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
  };
}

/** waitGate：loopIndex >= 1 且无人工产物 → 挂起（首次执行挂起一次）；resume 后读 task_result 直接通过。 */
const waitGateDef: INodeDefinition = {
  type: "waitGate",
  name: "waitGate",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    const submitted = ctx.get("workflow", `task_result:${ctx.node.id}`);
    if (submitted !== undefined) {
      return { output: submitted };
    }
    const index = ctx.getByPath("workflow:loopIndex");
    if (typeof index === "number" && index >= 1) {
      ctx.suspend({ title: "循环内审批" });
    }
    return { output: `auto-${String(index)}` };
  },
};

// 独立 registry：内置 + 自定义测试节点（boomIndex/waitGate），经 ctx.registry 透传给 body 子引擎。
const boomState = { runs: 0 };

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

/** 断言 RunState 快照存在并返回（undefined 视为测试失败）。 */
function expectSnap(snap: RunState | undefined): RunState {
  if (snap === undefined) {
    throw new Error("expected run state");
  }
  return snap;
}

const sharedDbs: SqliteDatabase[] = [];
afterAll(async () => {
  for (const db of sharedDbs) db.close();
  await rmRetry(TEMP_BASE);
}, 30000);

describe("loop 失败中断恢复（结果持久化）", () => {
  test("第 3 次迭代失败：已完成迭代结果保留，重建引擎从失败迭代继续并补全 results", async () => {
    const dbPath = nextDbPath("fail");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const body = boomBody(boomIndexNode("boom", 2));
    const wf = parentWorkflow("loop", { items: 5, body }, "loop-fail-rec");
    const reg = makeRegistry([boomIndexDef(boomState)]);
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);

    const engine1 = new ExecutionEngine(wf, {
      registry: reg,
      runId: "loop-fail-rec-1",
      persist: true,
      runStateStore: runStore,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("failed");
    expect(r1.nodeStates["loop"]).toBe("Failed");
    expect(boomState.runs).toBe(3); // 迭代 0、1 成功，迭代 2 失败

    // 断点快照：进度 = 失败迭代下标；已完成迭代（0、1）的 endResult 已持久化在 loopResults。
    const snap = expectSnap(await runStore.getById("loop-fail-rec-1"));
    expect(snap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(2);
    expect(snap.contextSnapshot.node["node:loop"]?.["loopResults"]).toEqual([
      "idx-0-item-0",
      "idx-1-item-1",
    ]);

    // 丢弃实例：从快照重建引擎继续（continueRun 重跑第一个 Failed=loop），读进度跳迭代、结果续收集。
    const r2 = await continueRun(
      buildEngineFromRunState(snap, { registry: reg, runStateStore: runStore, persist: true }),
      snap,
    );
    expect(r2.status).toBe("success");
    expect(r2.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-0",
      "idx-1-item-1",
      "idx-2-item-2",
      "idx-3-item-3",
      "idx-4-item-4",
    ]);
    expect(boomState.runs).toBe(6); // 恢复后重跑迭代 2、3、4

    // 终态快照：loopResults = 全量结果，loopProgress = items.length。
    const finalSnap = expectSnap(await runStore.getById("loop-fail-rec-1"));
    expect(finalSnap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(5);
    expect(finalSnap.contextSnapshot.node["node:loop"]?.["loopResults"]).toEqual([
      "idx-0-item-0",
      "idx-1-item-1",
      "idx-2-item-2",
      "idx-3-item-3",
      "idx-4-item-4",
    ]);
  });
});

describe("loop 迭代内挂起恢复", () => {
  test("迭代 1 挂起 → resumeTask 跳迭代续跑：任务复用不重复、用户输入保留、results 完整", async () => {
    const dbPath = nextDbPath("wait");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const body = waitBody(waitGateNode("wait"));
    const wf = parentWorkflow("loop", { items: ["a", "b", "c"], body }, "loop-wait-rec");
    const reg = makeRegistry([waitGateDef]);
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);

    const engine1 = new ExecutionEngine(wf, {
      registry: reg,
      runId: "loop-wait-rec-1",
      persist: true,
      runStateStore: runStore,
      humanTaskStore: humanStore,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("waiting");
    const task = expectWaiting(r1);
    // 路径标识：body 子引擎 workflowId = 父id:loop节点id；挂起节点为 body 内 waitGate。
    expect(task.workflowId).toBe("loop-wait-rec:loop");
    expect(task.nodeId).toBe("wait");
    expect(await humanStore.listAll()).toHaveLength(1);

    // 断点快照：进度 = 挂起迭代下标（1）；已完成迭代（0）结果已持久化。
    const snap = expectSnap(await runStore.getById("loop-wait-rec-1"));
    expect(snap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(1);
    expect(snap.contextSnapshot.node["node:loop"]?.["loopResults"]).toEqual(["auto-0"]);

    // 丢弃实例 → resumeTask：loop 跳迭代重跑 body，task_result 透传（不重复挂起/创建任务），后续迭代完成。
    const r2 = await resumeTask(
      task.id,
      { registry: reg, runStateStore: runStore, humanTaskStore: humanStore, persist: true },
      "user-approve",
    );
    expect(r2.status).toBe("success");
    // 迭代 0 结果续收集保留；迭代 1、2 读到用户输入（透传）。
    expect(r2.nodeOutputs["loop"]?.["results"]).toEqual([
      "auto-0",
      "user-approve",
      "user-approve",
    ]);
    // 任务复用：总数仍 1（无重复创建），无残留 pending；用户输入不丢（含在最终 results）。
    expect(await humanStore.listAll()).toHaveLength(1);
    expect(await humanStore.listPending()).toHaveLength(0);

    // 终态快照：loopResults = 全量，loopProgress = items.length。
    const finalSnap = expectSnap(await runStore.getById("loop-wait-rec-1"));
    expect(finalSnap.contextSnapshot.node["node:loop"]?.["loopResults"]).toEqual([
      "auto-0",
      "user-approve",
      "user-approve",
    ]);
    expect(finalSnap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(3);
  });
});

describe("loop 断点恢复进度读取", () => {
  test("restoreState/rebuildContext 后 loop 读 loopProgress 跳迭代、读 loopResults 续收集", async () => {
    const dbPath = nextDbPath("restore");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const body = interpolateBody();
    const wf = parentWorkflow("loop", { items: ["a", "b", "c"], body }, "loop-restore-rec");
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);

    // 直接构造断点：loop 已执行 2 次迭代（loopProgress=2），已完成结果在 loopResults。
    const runState: RunState = {
      runId: "loop-restore-rec-1",
      workflowId: wf.id,
      workflow: wf,
      nodeStates: { start: "Success", loop: "Idle", end: "Idle" },
      nodeOutputs: {},
      contextSnapshot: {
        global: {},
        workflow: {},
        node: {
          "node:loop": {
            loopProgress: 2,
            loopResults: ["idx-0-item-a", "idx-1-item-b"],
          },
        },
      },
      status: "running",
      updatedAt: 1000,
    };
    await runStore.create(runState);

    // 重建引擎：loop 从断点读进度跳迭代（不重跑已完成迭代），结果续收集 → 最终 results 完整。
    const r = await continueRun(
      buildEngineFromRunState(runState, { runStateStore: runStore }),
      runState,
    );
    expect(r.status).toBe("success");
    expect(r.nodeOutputs["loop"]?.["results"]).toEqual([
      "idx-0-item-a",
      "idx-1-item-b",
      "idx-2-item-c",
    ]);
  });
});

describe("loop 空数组边界", () => {
  test("空 items：0 次迭代 results 空数组，loopResults 终值为空数组", async () => {
    const dbPath = nextDbPath("empty");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const body = interpolateBody();
    const wf = parentWorkflow("loop", { items: [], body }, "loop-empty-rec");
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);

    const engine = new ExecutionEngine(wf, {
      runId: "loop-empty-rec-1",
      persist: true,
      runStateStore: runStore,
    });
    const r = await engine.run();
    expect(r.status).toBe("success");
    expect(r.nodeOutputs["loop"]?.["results"]).toEqual([]);

    const snap = expectSnap(await runStore.getById("loop-empty-rec-1"));
    expect(snap.contextSnapshot.node["node:loop"]?.["loopResults"]).toEqual([]);
    expect(snap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(0);
  });
});
