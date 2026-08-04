// ExecutionLogStore 存储测试：批量缓冲、显式 flush、条件查询、data 往返、autoFlush、close 行为。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionLogStore } from "../src/logs/ExecutionLogStore.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\logs-test";

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
}, 30000);

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows bun:sqlite 句柄释放可达数秒。 */
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

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

describe("缓冲与 flush", () => {
  test("append 未 flush 不落库，flush 后 listByRun 往返一致", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("buffered"));
    store.append({ runId: "run-1", workflowId: "wf-1", nodeId: "node-1", level: "info", message: "hello" });
    expect(await store.listByRun("run-1")).toHaveLength(0); // 未 flush 查不到
    await store.flush();
    const rows = await store.listByRun("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("hello");
    expect(rows[0]?.runId).toBe("run-1");
    expect(rows[0]?.workflowId).toBe("wf-1");
    expect(rows[0]?.nodeId).toBe("node-1");
    expect(rows[0]?.level).toBe("info");
    expect(typeof rows[0]?.id).toBe("string"); // id 自动生成
    expect(typeof rows[0]?.createdAt).toBe("number"); // createdAt 自动生成
    await store.close();
  });

  test("无库文件时构造 ExecutionLogStore 自动建库建表", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("autocreate"));
    store.append({ runId: "run-a", workflowId: "wf-a", nodeId: "node-a", level: "error", message: "boom" });
    await store.flush();
    expect(await store.list({ level: "error" })).toHaveLength(1);
    await store.close();
  });
});

describe("批量与过滤", () => {
  test("批量 append → flush → list 全量返回且按条件过滤正确", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("batch"));
    for (let i = 0; i < 10; i++) {
      store.append({
        runId: i % 2 === 0 ? "run-even" : "run-odd",
        workflowId: "wf-b",
        nodeId: `node-${i}`,
        level: i % 3 === 0 ? "error" : "info",
        message: `msg-${i}`,
      });
    }
    await store.flush();
    expect(await store.list()).toHaveLength(10);
    expect(await store.list({ runId: "run-even" })).toHaveLength(5);
    expect(await store.list({ workflowId: "wf-b" })).toHaveLength(10);
    expect(await store.list({ nodeId: "node-1" })).toHaveLength(1);
    expect(await store.list({ level: "error" })).toHaveLength(4); // i=0,3,6,9
    expect(await store.list({ runId: "run-odd", level: "info" })).toHaveLength(3); // i=1,5,7
    expect(await store.listByNode("node-2")).toHaveLength(1);
    expect(await store.listByWorkflow("wf-b")).toHaveLength(10);
    await store.close();
  });

  test("data 对象往返：append 传 {a:1}，list 后解析相等", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("data"));
    store.append({
      runId: "run-d",
      workflowId: "wf-d",
      nodeId: "node-d",
      level: "info",
      message: "with data",
      data: { a: 1, nested: { b: [1, 2, 3] } },
    });
    await store.flush();
    const rows = await store.listByRun("run-d");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ a: 1, nested: { b: [1, 2, 3] } });
    await store.close();
  });

  test("listRecent(limit) 返回最近 N 条（降序）", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("recent"));
    for (let i = 0; i < 5; i++) {
      store.append({
        runId: "run-r",
        workflowId: "wf-r",
        nodeId: "node-r",
        level: "info",
        message: `msg-${i}`,
        createdAt: 1000 + i,
      });
    }
    await store.flush();
    const recent = await store.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.message).toBe("msg-4");
    expect(recent[1]?.message).toBe("msg-3");
    await store.close();
  });
});

describe("autoFlush 与 close", () => {
  test("autoFlushMs 生效：append 后自动落库可读", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("autoflush"), { autoFlushMs: 50 });
    try {
      store.append({ runId: "run-auto", workflowId: "wf-auto", nodeId: "node-auto", level: "warn", message: "auto" });
      await new Promise((resolve) => setTimeout(resolve, 200)); // 等 autoFlush 定时器跑过
      const rows = await store.listByRun("run-auto");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toBe("auto");
    } finally {
      await store.close();
    }
  });

  test("close() 后 append 同步抛错、flush/list 异步拒绝", async () => {
    const store = new ExecutionLogStore(nextFileDbPath("closed"));
    await store.close();
    expect(() => store.append({ runId: "r", workflowId: "w", nodeId: "n", level: "info", message: "x" })).toThrow(/已关闭/);
    await expect(store.flush()).rejects.toThrow(/已关闭/);
    await expect(store.list()).rejects.toThrow(/已关闭/);
  });

  test("close() 会 flush 剩余缓冲", async () => {
    const dbPath = nextFileDbPath("closeflush");
    const store = new ExecutionLogStore(dbPath);
    store.append({ runId: "run-c", workflowId: "wf-c", nodeId: "node-c", level: "info", message: "closing" });
    await store.close(); // 未显式 flush，close 应把缓冲落库
    const check = new ExecutionLogStore(dbPath); // 同路径重开验证落库结果
    try {
      const rows = await check.listByRun("run-c");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toBe("closing");
    } finally {
      await check.close();
    }
  });
});
