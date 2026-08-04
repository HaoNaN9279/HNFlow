// SQLite 事务基础设施测试（v0.2.1）：adapter 事务 API、嵌套事务拒绝、共享连接注入、store 缺省行为回归。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../src/db/index.js";
import { SqliteHumanTaskStore, SqliteRunStateStore } from "../src/db/stores.js";
import type { Workflow } from "../src/model/types.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\db-transaction-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  // Windows 上 sqlite 句柄释放有瞬态延迟，重试删除避免 EBUSY。
  await rmRetry(TEMP_BASE);
}, 30000);

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

/** 插入一条 execution_logs 记录，返回日志 id。 */
function insertLog(handle: Awaited<ReturnType<typeof openDatabase>>, id: string): void {
  handle.db
    .prepare(
      "INSERT INTO execution_logs (id, run_id, workflow_id, node_id, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, "run-1", "wf-1", "node-1", "info", `msg-${id}`, "{}", 1000);
}

function logExists(handle: Awaited<ReturnType<typeof openDatabase>>, id: string): boolean {
  return handle.db.prepare("SELECT 1 AS one FROM execution_logs WHERE id = ?").get(id) !== undefined;
}

describe("adapter 事务 API", () => {
  test("begin → 插入 → commit：数据持久化可见", async () => {
    const handle = await openDatabase(nextDbPath("tx-commit"));
    try {
      handle.ensureSchema();
      const tx = handle.db.begin();
      insertLog(handle, "log-commit");
      tx.commit();
      expect(logExists(handle, "log-commit")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("begin → 插入 → rollback：数据不落库", async () => {
    const handle = await openDatabase(nextDbPath("tx-rollback"));
    try {
      handle.ensureSchema();
      const tx = handle.db.begin();
      insertLog(handle, "log-rb");
      tx.rollback();
      expect(logExists(handle, "log-rb")).toBe(false);
      // 回滚后连接仍可用，可开新事务。
      const tx2 = handle.db.begin();
      insertLog(handle, "log-rb2");
      tx2.commit();
      expect(logExists(handle, "log-rb2")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("事务中抛异常 → 调用方 rollback → 数据不落库", async () => {
    const handle = await openDatabase(nextDbPath("tx-exception"));
    try {
      handle.ensureSchema();
      const tx = handle.db.begin();
      insertLog(handle, "log-ex");
      let caught: unknown;
      try {
        throw new Error("业务处理失败");
      } catch (error) {
        caught = error;
        tx.rollback();
      }
      expect(caught).toBeInstanceOf(Error);
      expect(logExists(handle, "log-ex")).toBe(false);
    } finally {
      handle.close();
    }
  });

  test("嵌套 begin 抛错（不支持嵌套事务）", async () => {
    const handle = await openDatabase(nextDbPath("tx-nested"));
    try {
      handle.ensureSchema();
      const outer = handle.db.begin();
      try {
        expect(() => handle.db.begin()).toThrow(/嵌套事务/);
      } finally {
        outer.rollback();
      }
      // rollback 后事务已结束，可再次 begin。
      const tx = handle.db.begin();
      tx.commit();
    } finally {
      handle.close();
    }
  });

  test("commit 后可开启新事务（事务生命周期独立）", async () => {
    const handle = await openDatabase(nextDbPath("tx-new"));
    try {
      handle.ensureSchema();
      const tx1 = handle.db.begin();
      insertLog(handle, "log-a");
      tx1.commit();
      const tx2 = handle.db.begin();
      insertLog(handle, "log-b");
      tx2.commit();
      expect(logExists(handle, "log-a")).toBe(true);
      expect(logExists(handle, "log-b")).toBe(true);
    } finally {
      handle.close();
    }
  });
});

describe("共享连接注入", () => {
  test("两个 store 同传一个 SqliteDatabase → 读写互见（同事务基础）", async () => {
    const shared = await openDatabase(nextDbPath("shared"));
    try {
      shared.ensureSchema();
      const humanStore = new SqliteHumanTaskStore("ignored-path.db", shared);
      const runStore = new SqliteRunStateStore("ignored-path.db", shared);
      try {
        await humanStore.create({ workflowId: "wf-shared", nodeId: "n1", nodeName: "审批", title: "共享任务" });
        await runStore.create(makeRunState({ runId: "shared-run", workflowId: "wf-shared", updatedAt: 1000 }));

        // 一 store 写入，另一 store 读到。
        expect((await runStore.getById("shared-run"))?.workflowId).toBe("wf-shared");
        expect((await humanStore.listAll())[0]?.title).toBe("共享任务");

        // 共享 handle 直查同样可见（证明同连接）。
        expect(shared.db.prepare("SELECT title FROM human_tasks WHERE workflow_id = ?").get("wf-shared")?.title).toBe("共享任务");
      } finally {
        await humanStore.close();
        await runStore.close();
      }
    } finally {
      shared.close();
    }
  });

  test("共享连接上同一事务：两 store 写入互见，rollback 后均不落库", async () => {
    const shared = await openDatabase(nextDbPath("shared-tx"));
    try {
      shared.ensureSchema();
      const humanStore = new SqliteHumanTaskStore("ignored-path.db", shared);
      const runStore = new SqliteRunStateStore("ignored-path.db", shared);
      try {
        const tx = shared.db.begin();
        await humanStore.create({ workflowId: "wf-tx", nodeId: "n1", nodeName: "审批", title: "事务任务" });
        await runStore.create(makeRunState({ runId: "tx-run", workflowId: "wf-tx", updatedAt: 1000 }));
        // 同一连接内未提交写入对另一 store 可见（read-your-writes）。
        expect((await runStore.getById("tx-run"))?.runId).toBe("tx-run");
        expect((await humanStore.listAll())[0]?.title).toBe("事务任务");
        tx.rollback();
        // 回滚后均不落库。
        expect(await runStore.getById("tx-run")).toBeUndefined();
        expect(await humanStore.listAll()).toHaveLength(0);
      } finally {
        await humanStore.close();
        await runStore.close();
      }
    } finally {
      shared.close();
    }
  });

  test("共享连接上同一事务 commit：两 store 写入同时持久化", async () => {
    const shared = await openDatabase(nextDbPath("shared-commit"));
    try {
      shared.ensureSchema();
      const humanStore = new SqliteHumanTaskStore("ignored-path.db", shared);
      const runStore = new SqliteRunStateStore("ignored-path.db", shared);
      try {
        const tx = shared.db.begin();
        await humanStore.create({ workflowId: "wf-c", nodeId: "n1", nodeName: "审批", title: "事务任务" });
        await runStore.create(makeRunState({ runId: "c-run", workflowId: "wf-c", updatedAt: 1000 }));
        tx.commit();
        // commit 后两表同时持久化。
        expect(await runStore.getById("c-run")).toBeDefined();
        expect((await humanStore.listAll())[0]?.title).toBe("事务任务");
      } finally {
        await humanStore.close();
        await runStore.close();
      }
    } finally {
      shared.close();
    }
  });

  test("共享 store close() 不关闭共享连接，store 仍可用", async () => {
    const shared = await openDatabase(nextDbPath("shared-close"));
    try {
      shared.ensureSchema();
      const humanStore = new SqliteHumanTaskStore("ignored-path.db", shared);
      await humanStore.close();
      // 共享连接未被 store.close() 关闭。
      shared.db.exec("SELECT 1");
      const created = await humanStore.create({ workflowId: "wf-close", nodeId: "n1", nodeName: "审批", title: "关闭后仍可用" });
      expect(created.id).toBeDefined();
      await humanStore.close();
    } finally {
      shared.close();
    }
  });
});

describe("缺省构造行为回归", () => {
  test("不传共享连接：独立连接懒打开 + 自动建表", async () => {
    const store = new SqliteRunStateStore(nextDbPath("solo"));
    try {
      await store.create(makeRunState({ runId: "solo-run", workflowId: "wf-solo", updatedAt: 1000 }));
      expect((await store.getById("solo-run"))?.runId).toBe("solo-run");
      expect((await store.list()).length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  test("ensureSchema 幂等：新建表与既有表共存", async () => {
    const handle = await openDatabase(nextDbPath("schema-v2"));
    try {
      handle.ensureSchema();
      handle.ensureSchema(); // 幂等重复执行不报错
      const tables = handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const names = tables.map((row) => row.name);
      expect(names).toContain("checkpoints");
      expect(names).toContain("checkpoint_writes");
      expect(names).toContain("run_state");
      expect(names).toContain("human_tasks");
    } finally {
      handle.close();
    }
  });
});
