// SQLite store 测试（T6）：RunState/HumanTask 的 SQLite 持久化、与 JSON 版行为等价、Engine 注入集成。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { HumanTask, HumanTaskSpec } from "../src/human/types.js";
import { HumanTaskStore, InvalidTaskStateError } from "../src/human/HumanTaskStore.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";
import { SqliteHumanTaskStore, SqliteRunStateStore } from "../src/db/stores.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\db-stores-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}
function nextJsonPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.json`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  // Windows 上 sqlite 句柄释放有瞬态延迟，重试删除避免 EBUSY。
  await rmRetry(TEMP_BASE);
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
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

/** 构造深对象 RunState（含 workflow 快照、contextSnapshot、可选 pending 字段）。 */
function makeRunState(overrides: { readonly runId: string; readonly workflowId: string; readonly updatedAt: number }): RunState {
  const workflow: Workflow = {
    id: overrides.workflowId,
    name: "wf",
    version: "0.1.0",
    nodes: [
      { id: "start", type: "start", name: "start", params: {}, inputs: [], outputs: [] },
      { id: "human", type: "humanTask", name: "审批", params: { title: "审批" }, inputs: [], outputs: [] },
    ],
    edges: [],
  };
  return {
    runId: overrides.runId,
    workflowId: overrides.workflowId,
    workflow,
    nodeStates: { start: "Success", human: "WaitingForHuman" },
    nodeOutputs: { start: { data: { value: 42 } } },
    contextSnapshot: { global: { g: "x" }, workflow: { w: [1, 2, 3] }, node: { "node:start": { k: "v" } } },
    pendingNodeId: "human",
    pendingTaskId: "task-1",
    status: "waiting",
    updatedAt: overrides.updatedAt,
  };
}

describe("SqliteRunStateStore", () => {
  test("create → getById 往返恢复完整 RunState（含 workflow 快照）", async () => {
    const store = new SqliteRunStateStore(nextDbPath("run"));
    try {
      const run = makeRunState({ runId: "run-1", workflowId: "wf-a", updatedAt: 1000 });
      await store.create(run);
      const loaded = await store.getById("run-1");
      expect(loaded).toEqual(run);
      expect(loaded?.workflow.nodes[1]?.params["title"]).toBe("审批");
      expect(loaded?.contextSnapshot.workflow["w"]).toEqual([1, 2, 3]);
    } finally {
      await store.close();
    }
  });

  test("update upsert：同 runId 覆盖旧值", async () => {
    const store = new SqliteRunStateStore(nextDbPath("run"));
    try {
      await store.create(makeRunState({ runId: "run-up", workflowId: "wf-a", updatedAt: 1000 }));
      await store.update(makeRunState({ runId: "run-up", workflowId: "wf-b", updatedAt: 2000 }));
      const loaded = await store.getById("run-up");
      expect(loaded?.workflowId).toBe("wf-b");
      expect(loaded?.updatedAt).toBe(2000);
      expect(await store.list()).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("list / listByWorkflow 过滤", async () => {
    const store = new SqliteRunStateStore(nextDbPath("run"));
    try {
      await store.create(makeRunState({ runId: "a1", workflowId: "wf-a", updatedAt: 1000 }));
      await store.create(makeRunState({ runId: "a2", workflowId: "wf-a", updatedAt: 2000 }));
      await store.create(makeRunState({ runId: "b1", workflowId: "wf-b", updatedAt: 3000 }));
      expect(await store.list()).toHaveLength(3);
      expect((await store.listByWorkflow("wf-a")).map((r) => r.runId)).toEqual(["a1", "a2"]);
      expect(await store.listByWorkflow("wf-nonexistent")).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  test("文件库不存在时首次访问自动建表", async () => {
    const store = new SqliteRunStateStore(nextDbPath("auto"));
    try {
      const run = makeRunState({ runId: "auto-1", workflowId: "wf-a", updatedAt: 100 });
      await store.create(run);
      expect((await store.getById("auto-1"))?.runId).toBe("auto-1");
    } finally {
      await store.close();
    }
  });
});

describe("SqliteHumanTaskStore", () => {
  function makeSpec(): HumanTaskSpec & { readonly workflowId: string; readonly nodeId: string; readonly nodeName: string } {
    return {
      workflowId: "wf-human",
      nodeId: "node-1",
      nodeName: "审批节点",
      title: "请审批",
      description: "这是一个审批任务",
      meta: { priority: "high", tags: ["a", "b"] },
    };
  }

  test("create → listAll / listPending 往返", async () => {
    const store = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const created = await store.create(makeSpec());
      expect(created.status).toBe("pending");
      expect(created.fallback).toBe("manual");
      const all = await store.listAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(created);
      expect(await store.listPending()).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("getById / findPending 正确", async () => {
    const store = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const created = await store.create(makeSpec());
      expect((await store.getById(created.id))?.title).toBe("请审批");
      expect(await store.getById("no-such")).toBeUndefined();
      const found = await store.findPending("wf-human", "node-1");
      expect(found?.id).toBe(created.id);
      expect(await store.findPending("wf-human", "other-node")).toBeUndefined();
      // 完成后 findPending 不再命中。
      await store.complete(created.id);
      expect(await store.findPending("wf-human", "node-1")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test("complete 设置 status/completedAt/result", async () => {
    const store = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const created = await store.create(makeSpec());
      const completed = await store.complete(created.id, { approved: true });
      expect(completed.status).toBe("completed");
      expect(typeof completed.completedAt).toBe("number");
      expect(completed.result).toEqual({ approved: true });
      const stored = await store.getById(created.id);
      expect(stored?.status).toBe("completed");
      expect(stored?.completedAt).toBeDefined();
      expect(stored?.result).toEqual({ approved: true });
      expect(await store.listPending()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  test("complete 已 complete / 不存在的任务抛 InvalidTaskStateError", async () => {
    const store = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const created = await store.create(makeSpec());
      await store.complete(created.id);
      await expect(store.complete(created.id)).rejects.toThrow(InvalidTaskStateError);
      await expect(store.skip(created.id)).rejects.toThrow(InvalidTaskStateError);
      await expect(store.complete("no-such-task")).rejects.toThrow(InvalidTaskStateError);
    } finally {
      await store.close();
    }
  });

  test("skip / defer 状态迁移", async () => {
    const store = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const skipped = await store.create({ ...makeSpec(), title: "skip" });
      const afterSkip = await store.skip(skipped.id);
      expect(afterSkip.status).toBe("skipped");
      expect((await store.getById(skipped.id))?.status).toBe("skipped");
      const deferred = await store.create({ ...makeSpec(), title: "defer" });
      await store.defer(deferred.id);
      expect((await store.getById(deferred.id))?.status).toBe("deferred");
      expect(await store.listPending()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  test("meta/description 可选字段往返（缺省为 NULL，读回缺省）", async () => {
    const store = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const bare = await store.create({ workflowId: "wf", nodeId: "n", nodeName: "n", title: "bare" });
      const stored = await store.getById(bare.id);
      expect(stored?.description).toBeUndefined();
      expect(stored?.meta).toBeUndefined();
      expect(stored?.result).toBeUndefined();
      expect(stored?.completedAt).toBeUndefined();
      expect(await store.listPending()).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

/** 提取 HumanTask 的关键字段（忽略 id/createdAt/completedAt 的运行时差异）。 */
function taskFields(task: HumanTask): Record<string, unknown> {
  return {
    workflowId: task.workflowId,
    nodeId: task.nodeId,
    nodeName: task.nodeName,
    title: task.title,
    status: task.status,
    fallback: task.fallback,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.meta === undefined ? {} : { meta: task.meta }),
    ...(task.result === undefined ? {} : { result: task.result }),
  };
}

describe("行为等价：Sqlite 版 vs JSON 版", () => {
  test("RunStateStore：getById/list/listByWorkflow 返回等价", async () => {
    const jsonStore = new RunStateStore({ filePath: nextJsonPath("eq-run") });
    const sqliteStore = new SqliteRunStateStore(nextDbPath("eq-run"));
    try {
      const runA = makeRunState({ runId: "eq-a", workflowId: "wf-a", updatedAt: 1000 });
      const runB = makeRunState({ runId: "eq-b", workflowId: "wf-a", updatedAt: 2000 });
      await jsonStore.create(runA);
      await sqliteStore.create(runA);
      await jsonStore.create(runB);
      await sqliteStore.create(runB);
      expect(await sqliteStore.getById("eq-a")).toEqual(await jsonStore.getById("eq-a"));
      expect(await sqliteStore.list()).toEqual(await jsonStore.list());
      expect(await sqliteStore.listByWorkflow("wf-a")).toEqual(await jsonStore.listByWorkflow("wf-a"));
      expect(await sqliteStore.listByWorkflow("nope")).toEqual(await jsonStore.listByWorkflow("nope"));
    } finally {
      await sqliteStore.close();
    }
  });

  test("HumanTaskStore：create/listPending/getById/findPending/complete 关键字段等价", async () => {
    const jsonStore = new HumanTaskStore({ filePath: nextJsonPath("eq-human") });
    const sqliteStore = new SqliteHumanTaskStore(nextDbPath("eq-human"));
    try {
      const spec = { workflowId: "wf-h", nodeId: "n1", nodeName: "审批", title: "审批", description: "desc", meta: { a: 1 } };
      const jsonTask = await jsonStore.create(spec);
      const sqliteTask = await sqliteStore.create(spec);
      expect(taskFields(sqliteTask)).toEqual(taskFields(jsonTask));

      expect((await sqliteStore.getById(sqliteTask.id)) !== undefined).toBe(true);
      expect((await jsonStore.getById(jsonTask.id)) !== undefined).toBe(true);
      expect(taskFields((await sqliteStore.getById(sqliteTask.id))!)).toEqual(taskFields((await jsonStore.getById(jsonTask.id))!));
      const sqlitePending = await sqliteStore.findPending("wf-h", "n1");
      const jsonPending = await jsonStore.findPending("wf-h", "n1");
      if (sqlitePending === undefined || jsonPending === undefined) {
        throw new Error("expected pending task");
      }
      expect(taskFields(sqlitePending)).toEqual(taskFields(jsonPending));
      expect((await sqliteStore.listPending()).map(taskFields)).toEqual((await jsonStore.listPending()).map(taskFields));

      const sqliteCompleted = await sqliteStore.complete(sqliteTask.id, { approved: true });
      const jsonCompleted = await jsonStore.complete(jsonTask.id, { approved: true });
      expect(taskFields(sqliteCompleted)).toEqual(taskFields(jsonCompleted));
      expect(taskFields((await sqliteStore.getById(sqliteTask.id))!)).toEqual(taskFields((await jsonStore.getById(jsonTask.id))!));
    } finally {
      await sqliteStore.close();
    }
  });
});

describe("Engine 集成：Sqlite store 注入", () => {
  function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
    const def = registry.get(type);
    return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
  }

  /** start → humanTask(title=审批) → log → end */
  function makeApprovalWorkflow(): Workflow {
    return {
      id: "db-stores-wf",
      name: "sqlite-approval",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("human", "humanTask", { title: "审批" }),
        makeNode("log", "log", { level: "info", message: "after approval" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
        { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "log", targetPortId: "in" },
        { id: "e3", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
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

  test("humanTask 挂起 → resume 恢复，Sqlite store 可查", async () => {
    const humanStore = new SqliteHumanTaskStore(nextDbPath("engine-human"));
    const runStore = new SqliteRunStateStore(nextDbPath("engine-run"));
    try {
      // T7：Engine options 已收窄为 like 接口，Sqlite 实现直接类型安全注入。
      const engine = new ExecutionEngine(makeApprovalWorkflow(), {
        humanTaskStore: humanStore,
        runStateStore: runStore,
        persist: true,
        runId: "engine-sqlite-1",
      });

      const result = await engine.run();
      expect(result.status).toBe("waiting");
      const task = expectWaiting(result);
      expect(task.title).toBe("审批");
      expect(result.nodeStates["human"]).toBe("WaitingForHuman");

      // 挂起快照已落库：RunState status=waiting + pendingTaskId。
      const snap = await runStore.getById("engine-sqlite-1");
      expect(snap?.status).toBe("waiting");
      expect(snap?.pendingNodeId).toBe("human");
      expect(snap?.pendingTaskId).toBe(task.id);

      // 挂起任务 store 可查。
      expect((await humanStore.getById(task.id))?.status).toBe("pending");
      expect((await humanStore.findPending("db-stores-wf", "human"))?.id).toBe(task.id);

      const resumed = await engine.resume(task.id, "approved");
      expect(resumed.status).toBe("success");
      expect(resumed.nodeStates["human"]).toBe("Success");

      // 完成后 store 可查：任务 completed + result，RunState success。
      const completed = await humanStore.getById(task.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.result).toBe("approved");
      expect((await runStore.getById("engine-sqlite-1"))?.status).toBe("success");
    } finally {
      await humanStore.close();
      await runStore.close();
    }
  });
});
