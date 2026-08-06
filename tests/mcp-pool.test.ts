/**
 * MCP 进程池测试：复用、空闲释放、崩溃重启、状态型重置、并发去重。
 *
 * 使用真实子进程（bun run tests/fixtures/mcp/<server>.ts），验证进程池语义。
 * 每个用例结束后统一 dispose 清理，严禁残留长驻子进程。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { McpServerPool } from "../src/mcp/pool.js";
import type { McpSession } from "../src/mcp/session.js";
import type { McpServerConfig } from "../src/mcp/types.js";

/** 无状态 echo Server 配置。 */
const ECHO_CONFIG: McpServerConfig = {
  name: "echo",
  command: "bun",
  args: ["run", "tests/fixtures/mcp/echo-server.ts"],
};

/** 状态型 counter Server 配置。 */
const STATEFUL_CONFIG: McpServerConfig = {
  name: "stateful",
  command: "bun",
  args: ["run", "tests/fixtures/mcp/stateful-server.ts"],
  stateful: true,
};

/** 已创建的进程池，逐个测试后统一 dispose 清理。 */
const pools: McpServerPool[] = [];

/** 创建测试进程池（登记以便清理）。 */
function createPool(idleTimeoutMs?: number): McpServerPool {
  const pool = new McpServerPool(
    idleTimeoutMs !== undefined ? { idleTimeoutMs } : undefined,
  );
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  while (pools.length > 0) {
    const pool = pools.pop();
    if (pool !== undefined) {
      await pool.dispose();
    }
  }
});

/** 等待条件成立（进程 exit / 状态迁移等异步事件）。 */
async function waitUntil(
  cond: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 强杀子进程：崩溃模拟。 */
function killSession(session: McpSession): void {
  const pid = session.getPid();
  if (pid !== null) {
    process.kill(pid, "SIGKILL");
  }
}

/** 解析 { count: N } 文本并返回 count。 */
function parseCount(text: string): number {
  const parsed = JSON.parse(text) as { count: number };
  return parsed.count;
}

describe("进程池复用", () => {
  test("同 name 顺序 acquire 返回同一会话，release 一次不释放进程", async () => {
    const pool = createPool();
    const s1 = await pool.acquire(ECHO_CONFIG);
    const s2 = await pool.acquire(ECHO_CONFIG);
    expect(s2).toBe(s1);
    expect(s1.getStatus()).toBe("ready");

    // release 一次：引用计数 2 → 1，进程仍在（未归 0 不启动空闲释放）
    pool.release(ECHO_CONFIG.name);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s1.getStatus()).toBe("ready");
  });
});

describe("空闲释放", () => {
  test("release 归 0 后 idleTimeoutMs 超时释放进程", async () => {
    const pool = createPool(50);
    const session = await pool.acquire(ECHO_CONFIG);
    pool.release(ECHO_CONFIG.name);
    await waitUntil(() => session.getStatus() === "released", "空闲超时释放");
  });
});

describe("崩溃重启", () => {
  test("kill 子进程后再次 acquire 得到可用的新会话", async () => {
    const pool = createPool();
    const s1 = await pool.acquire(ECHO_CONFIG);
    killSession(s1);
    await waitUntil(() => s1.getStatus() === "dead", "崩溃标记");

    const s2 = await pool.acquire(ECHO_CONFIG);
    expect(s2).not.toBe(s1);
    expect(s2.getStatus()).toBe("ready");
    const result = await s2.callTool("echo", { text: "reborn" });
    expect(result.text).toBe("echo: reborn");
  });
});

describe("状态型重置", () => {
  test("状态型 Server 崩溃后重建实例，计数归零", async () => {
    const pool = createPool();
    const s1 = await pool.acquire(STATEFUL_CONFIG);
    expect(parseCount((await s1.callTool("counter_increment", {})).text)).toBe(1);
    expect(parseCount((await s1.callTool("counter_increment", {})).text)).toBe(2);
    killSession(s1);
    await waitUntil(() => s1.getStatus() === "dead", "状态型崩溃标记");

    const s2 = await pool.acquire(STATEFUL_CONFIG);
    expect(s2).not.toBe(s1);
    expect(s2.getStatus()).toBe("ready");
    // 新进程：状态归零
    expect(parseCount((await s2.callTool("get_counter", {})).text)).toBe(0);
    expect(parseCount((await s2.callTool("counter_increment", {})).text)).toBe(1);
  });
});

describe("并发去重", () => {
  test("同 name 同时 acquire 只 spawn 一个进程", async () => {
    const pool = createPool();
    const [s1, s2, s3] = await Promise.all([
      pool.acquire(ECHO_CONFIG),
      pool.acquire(ECHO_CONFIG),
      pool.acquire(ECHO_CONFIG),
    ]);
    // 去重：三个 acquire 共享同一会话
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    // 同一子进程 pid
    const pid = s1.getPid();
    expect(pid).not.toBeNull();
    if (pid !== null) {
      expect(s2.getPid()).toBe(pid);
      expect(s3.getPid()).toBe(pid);
    }
    // release 后（默认超时 5 分钟）进程仍存活
    pool.release(ECHO_CONFIG.name);
    pool.release(ECHO_CONFIG.name);
    pool.release(ECHO_CONFIG.name);
    expect(s1.getStatus()).toBe("ready");
  });
});
