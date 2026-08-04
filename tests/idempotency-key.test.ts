// 幂等键基础设施测试（v0.2.5 T2）：Engine 注册判重 + RunState 持久化 + SQLite schema 迁移 + store createIfAbsent。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { INodeDefinition } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { IdempotencyKeyConflictError } from "../src/execution/errors.js";
import { resumeTask } from "../src/execution/resume.js";
import { SqliteHumanTaskStore, SqliteRunStateStore, openDatabase } from "../src/db/index.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\idempotency-key-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string { return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`); }
function nextJsonPath(prefix: string): string { return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.json`); }

beforeAll(async () => { await mkdir(TEMP_BASE, { recursive: true }); });
afterAll(async () => { await rmRetry(TEMP_BASE); }, 30000);

/** 带重试的递归删除（Windows sqlite 句柄瞬态锁 EBUSY）。 */
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

/** 独立注册表：内置节点 + 计数节点（断言重复 run 不执行副作用）。 */
function makeRegistry(): { readonly reg: NodeRegistry; readonly counter: { value: number } } {
  const counter = { value: 0 };
  const counterDef: INodeDefinition = {
    type: "idemCounter",
    name: "idemCounter",
    inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
    outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
    async execute() { counter.value++; return { out: counter.value }; },
  };
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  reg.register(counterDef);
  return { reg, counter };
}

function makeNode(id: string, type: string, reg: NodeRegistry, name = id, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = reg.get(type);
  return { id, type, name, params, inputs: def.inputs, outputs: def.outputs };
}

/** start → 计数节点 → end。 */
function makeWorkflow(id: string, reg: NodeRegistry): Workflow {
  return {
    id, name: `wf-${id}`, version: "0.1.0",
    nodes: [
      makeNode("start", "start", reg),
      makeNode("counter", "idemCounter", reg, "counter"),
      makeNode("end", "end", reg),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "counter", targetPortId: "in" },
      { id: "e2", sourceNodeId: "counter", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** start → humanTask → end（挂起/恢复场景，显式传 humanTaskStore）。 */
function makeHumanWorkflow(id: string, reg: NodeRegistry): Workflow {
  return {
    id, name: `wf-${id}`, version: "0.1.0",
    nodes: [
      makeNode("start", "start", reg),
      makeNode("human", "humanTask", reg, "审批", { title: "审批" }),
      makeNode("end", "end", reg),
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 构造最小 RunState（overrides 覆盖默认字段）。 */
function makeRunState(runId: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runId, workflowId: "wf-x", workflow: { id: "wf-x", name: "w", version: "0.1.0", nodes: [], edges: [] },
    nodeStates: {}, nodeOutputs: {}, contextSnapshot: { global: {}, workflow: {}, node: {} },
    status: "running", updatedAt: 100, ...overrides,
  };
}

describe("Engine 幂等注册判重（SQLite）", () => {
  test("带 key 首次 run：success，RunState 含 idempotencyKey", async () => {
    const { reg, counter } = makeRegistry();
    const runStore = new SqliteRunStateStore(nextDbPath("run"));
    try {
      const engine = new ExecutionEngine(makeWorkflow("wf-1", reg), {
        registry: reg, runStateStore: runStore, persist: true, idempotencyKey: "req-1",
      });
      const result = await engine.run();
      expect(result.status).toBe("success");
      expect(counter.value).toBe(1);
      expect((await runStore.getById(engine.runId))?.idempotencyKey).toBe("req-1");
    } finally { await runStore.close(); }
  });

  test("同 workflow+同 key 第二次 run：抛冲突且副作用不执行（计数不变）", async () => {
    const { reg, counter } = makeRegistry();
    const runStore = new SqliteRunStateStore(nextDbPath("run"));
    try {
      const first = new ExecutionEngine(makeWorkflow("wf-2", reg), {
        registry: reg, runStateStore: runStore, persist: true, idempotencyKey: "req-2",
      });
      expect((await first.run()).status).toBe("success");
      expect(counter.value).toBe(1);
      const second = new ExecutionEngine(makeWorkflow("wf-2", reg), {
        registry: reg, runStateStore: runStore, persist: true, idempotencyKey: "req-2",
      });
      await expect(second.run()).rejects.toThrow(IdempotencyKeyConflictError);
      expect(counter.value).toBe(1); // 判重先于执行，副作用未跑
    } finally { await runStore.close(); }
  });

  test("同 workflow 不同 key：各自可运行", async () => {
    const { reg, counter } = makeRegistry();
    const runStore = new SqliteRunStateStore(nextDbPath("run"));
    try {
      for (const key of ["k-a", "k-b"]) {
        const engine = new ExecutionEngine(makeWorkflow("wf-3", reg), {
          registry: reg, runStateStore: runStore, persist: true, idempotencyKey: key,
        });
        expect((await engine.run()).status).toBe("success");
      }
      expect(counter.value).toBe(2);
      expect(await runStore.list()).toHaveLength(2);
    } finally { await runStore.close(); }
  });

  test("不同 workflow 同 key：不冲突", async () => {
    const { reg, counter } = makeRegistry();
    const runStore = new SqliteRunStateStore(nextDbPath("run"));
    try {
      for (const wfId of ["wf-4a", "wf-4b"]) {
        const engine = new ExecutionEngine(makeWorkflow(wfId, reg), {
          registry: reg, runStateStore: runStore, persist: true, idempotencyKey: "shared-key",
        });
        expect((await engine.run()).status).toBe("success");
      }
      expect(counter.value).toBe(2);
    } finally { await runStore.close(); }
  });

  test("恢复路径豁免：挂起后 resumeTask（不带 key）不被判重，恢复正常", async () => {
    const { reg } = makeRegistry();
    const runStore = new SqliteRunStateStore(nextDbPath("run"));
    const humanStore = new SqliteHumanTaskStore(nextDbPath("human"));
    try {
      const engine = new ExecutionEngine(makeHumanWorkflow("wf-5", reg), {
        registry: reg, humanTaskStore: humanStore, runStateStore: runStore, persist: true, idempotencyKey: "req-5",
      });
      const result = await engine.run();
      expect(result.status).toBe("waiting");
      const task = result.waitingTask;
      if (task === undefined) throw new Error("expected waiting task");
      expect((await runStore.getById(engine.runId))?.status).toBe("waiting");
      // 恢复不携带幂等键 → 豁免判重；挂起任务正常恢复完成。
      const resumed = await resumeTask(task.id, {
        registry: reg, humanTaskStore: humanStore, runStateStore: runStore, persist: true,
      }, "approved");
      expect(resumed.status).toBe("success");
      expect(resumed.nodeStates["human"]).toBe("Success");
    } finally { await runStore.close(); await humanStore.close(); }
  });
});

describe("SQLite schema 迁移", () => {
  test("旧 schema 库打开后自动迁移：列+索引存在、旧数据完好、createIfAbsent 可用", async () => {
    const dbPath = nextDbPath("migrate");
    // 预建旧 schema 库（无 idempotency_key 列）+ 旧数据（绕过 ensureSchema 直接建表；state 列存合法 RunState JSON）。
    const legacy = await openDatabase(dbPath);
    legacy.db.exec("CREATE TABLE run_state (run_id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT, state TEXT, updated_at INTEGER)");
    legacy.db.exec(`INSERT INTO run_state (run_id, workflow_id, status, state, updated_at) VALUES ('old-1', 'wf-old', 'success', '${JSON.stringify(makeRunState("old-1", { workflowId: "wf-old", status: "success", updatedAt: 100 }))}', 100)`);
    legacy.db.exec(`INSERT INTO run_state (run_id, workflow_id, status, state, updated_at) VALUES ('old-2', 'wf-old', 'success', '${JSON.stringify(makeRunState("old-2", { workflowId: "wf-old", status: "success", updatedAt: 200 }))}', 200)`);
    legacy.close();

    const store = new SqliteRunStateStore(dbPath);
    try {
      // 迁移后 createIfAbsent 可用（含 idempotency_key 列写入）。
      const run = makeRunState("new-1", { workflowId: "wf-old", idempotencyKey: "key-1", updatedAt: 300 });
      expect(await store.createIfAbsent(run)).toBe(true);
      // 同 workflow+key 重复 → false（唯一索引生效）。
      expect(await store.createIfAbsent(makeRunState("new-2", { workflowId: "wf-old", idempotencyKey: "key-1" }))).toBe(false);
      // 旧数据完好。
      expect((await store.getById("old-1"))?.status).toBe("success");
      expect(await store.list()).toHaveLength(3);
    } finally { await store.close(); }

    // 库级验证：列 + 唯一索引已存在。
    const reopened = await openDatabase(dbPath);
    const columns = reopened.db.prepare("PRAGMA table_info(run_state)").all();
    expect(columns.some((column) => column.name === "idempotency_key")).toBe(true);
    const indexes = reopened.db.prepare("PRAGMA index_list(run_state)").all();
    expect(indexes.some((index) => index.name === "idx_run_state_idempotency")).toBe(true);
    reopened.close();
  });
});

describe("JSON store createIfAbsent（先查后建，非原子）", () => {
  test("同 runId / 同 workflow+key 拒绝，新键插入", async () => {
    const store = new RunStateStore({ filePath: nextJsonPath("json") });
    const base = makeRunState("j-1", { workflowId: "wf-j", idempotencyKey: "k-1" });
    expect(await store.createIfAbsent(base)).toBe(true);
    expect(await store.createIfAbsent(makeRunState("j-1", { workflowId: "wf-j", idempotencyKey: "k-1" }))).toBe(false); // 同 runId
    expect(await store.createIfAbsent(makeRunState("j-2", { workflowId: "wf-j", idempotencyKey: "k-1" }))).toBe(false); // 同 key
    expect(await store.createIfAbsent(makeRunState("j-3", { workflowId: "wf-j", idempotencyKey: "k-2" }))).toBe(true);
    expect(await store.list()).toHaveLength(2);
  });
});

describe("create 覆盖语义回归（既有 upsert 行为不变）", () => {
  test("JSON store：同 runId update 两次 → 单条且最新", async () => {
    const store = new RunStateStore({ filePath: nextJsonPath("json") });
    await store.create(makeRunState("u-1", { status: "running", updatedAt: 100 }));
    await store.update(makeRunState("u-1", { status: "success", updatedAt: 200 }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("success");
    expect(all[0]?.updatedAt).toBe(200);
  });

  test("SQLite store：同 runId update 两次 → 单条且最新", async () => {
    const store = new SqliteRunStateStore(nextDbPath("run"));
    try {
      await store.create(makeRunState("s-1", { workflowId: "wf-s", status: "running", updatedAt: 100 }));
      await store.update(makeRunState("s-1", { workflowId: "wf-s", status: "success", updatedAt: 200 }));
      const loaded = await store.getById("s-1");
      expect(loaded?.status).toBe("success");
      expect(loaded?.updatedAt).toBe(200);
      expect(await store.list()).toHaveLength(1);
    } finally { await store.close(); }
  });
});
