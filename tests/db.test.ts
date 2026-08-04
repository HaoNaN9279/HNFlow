// SQLite 适配层测试：文件库 WAL/建表/CRUD/changes 归一化、内存库可用性、驱动检测与 node 分支结构保证。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectDriver, openAdapter } from "../src/db/adapter.js";
import { openDatabase } from "../src/db/index.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\db-test";

let fileCounter = 0;

/** 生成唯一文件库路径（同描述块内多次打开互不干扰）。 */
function nextFileDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  // Windows 上 bun:sqlite 释放文件句柄可能有瞬态延迟，重试删除避免 EBUSY
  await rmRetry(TEMP_BASE);
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows bun:sqlite 句柄释放可达数秒。 */
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

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

describe("驱动检测", () => {
  test("bun test 环境下 detectDriver 返回 bun", () => {
    expect(detectDriver()).toBe("bun");
  });
});

describe("文件库", () => {
  test("ensureSchema 后 journal_mode 为 wal", async () => {
    const handle = await openDatabase(nextFileDbPath("wal"));
    try {
      handle.ensureSchema(); // WAL 模式由 ensureSchema 设置
      const row = handle.db.prepare("PRAGMA journal_mode").get();
      expect(row?.journal_mode).toBe("wal");
    } finally {
      handle.close();
    }
  });

  test("ensureSchema 后 sqlite_master 含三张业务表", async () => {
    const handle = await openDatabase(nextFileDbPath("schema"));
    try {
      handle.ensureSchema();
      const tables = handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const names = tables.map((row) => row.name);
      expect(names).toContain("execution_logs");
      expect(names).toContain("run_state");
      expect(names).toContain("human_tasks");
    } finally {
      handle.close();
    }
  });

  test("CRUD 往返且 changes 归一化为 number", async () => {
    const handle = await openDatabase(nextFileDbPath("crud"));
    try {
      handle.ensureSchema();
      const insert = handle.db.prepare(
        "INSERT INTO execution_logs (id, run_id, workflow_id, node_id, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const result = insert.run("log-1", "run-1", "wf-1", "node-1", "info", "hello", "{}", 1000);
      expect(typeof result.changes).toBe("number");
      expect(result.changes).toBe(1);

      const row = handle.db.prepare("SELECT * FROM execution_logs WHERE id = ?").get("log-1");
      expect(row?.message).toBe("hello");
      expect(row?.run_id).toBe("run-1");

      const all = handle.db.prepare("SELECT * FROM execution_logs").all();
      expect(all).toHaveLength(1);

      const updated = handle.db.prepare("UPDATE execution_logs SET level = ? WHERE id = ?").run("error", "log-1");
      expect(updated.changes).toBe(1);

      const deleted = handle.db.prepare("DELETE FROM execution_logs WHERE id = ?").run("log-1");
      expect(deleted.changes).toBe(1);
      expect(handle.db.prepare("SELECT * FROM execution_logs WHERE id = ?").get("log-1")).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});

describe("内存库", () => {
  test(":memory: 可打开并建表，不断言 wal", async () => {
    const handle = await openDatabase(":memory:");
    try {
      handle.ensureSchema();
      const tables = handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables.map((row) => row.name)).toContain("execution_logs");
      // 内存库 journal_mode 为 memory，仅断言返回值为字符串
      const mode = handle.db.prepare("PRAGMA journal_mode").get();
      expect(typeof mode?.journal_mode).toBe("string");
    } finally {
      handle.close();
    }
  });
});

describe("node 驱动分支（结构保证）", () => {
  test("bun 下 openAdapter('node') 在动态 import 处失败，证明 node:sqlite 无顶层加载", async () => {
    await expect(openAdapter("node", ":memory:")).rejects.toThrow();
  });

  test("openDatabase 支持 driver 覆盖参数（bun 下 node 分支必然失败）", async () => {
    await expect(openDatabase(":memory:", { driver: "node" })).rejects.toThrow();
  });
});
