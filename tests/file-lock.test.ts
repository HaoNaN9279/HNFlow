// 跨进程文件锁测试。
// 覆盖：正常 acquire/release、他人持锁、死进程锁回收、过期锁回收、
// disabled 关闭、损坏锁降级警告、release 幂等、心跳写失败降级。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLock } from "../src/lock/file-lock.js";

/** 路径是否存在。 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "file-lock-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileLock", () => {
  test("正常 acquire/release：锁文件创建、owner 记录、释放删除", async () => {
    const lock = new FileLock({ dir, name: "instance" });
    const res = await lock.acquire();
    expect(res.ok).toBe(true);
    expect(res.owner?.pid).toBe(process.pid);
    expect(lock.isHeldBySelf()).toBe(true);
    expect(await exists(join(dir, "instance.lock"))).toBe(true);
    expect((await FileLock.readOwner(dir, "instance"))?.pid).toBe(process.pid);
    await lock.release();
    expect(lock.isHeldBySelf()).toBe(false);
    expect(await exists(join(dir, "instance.lock"))).toBe(false);
  });

  test("第二次 acquire（未释放）→ ok:false 且无警告", async () => {
    const a = new FileLock({ dir, name: "instance" });
    const b = new FileLock({ dir, name: "instance" });
    await a.acquire();
    const res = await b.acquire();
    expect(res.ok).toBe(false);
    expect(res.warning).toBeUndefined();
    await a.release();
  });

  test("死进程锁回收：写死 pid 的锁 → acquire 成功且锁归本进程", async () => {
    await writeFile(
      join(dir, "instance.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() })}\n`,
      "utf8",
    );
    const lock = new FileLock({ dir, name: "instance" });
    const res = await lock.acquire();
    expect(res.ok).toBe(true);
    expect((await FileLock.readOwner(dir, "instance"))?.pid).toBe(process.pid);
    await lock.release();
  });

  test("过期锁回收：startedAt 超 staleMs → acquire 成功", async () => {
    await writeFile(
      join(dir, "instance.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 })}\n`,
      "utf8",
    );
    const lock = new FileLock({ dir, name: "instance", staleMs: 10_000 });
    const res = await lock.acquire();
    expect(res.ok).toBe(true);
    expect((await FileLock.readOwner(dir, "instance"))?.pid).toBe(process.pid);
    await lock.release();
  });

  test("disabled:true → ok:true 且不创建锁文件", async () => {
    const lock = new FileLock({ dir, name: "instance", disabled: true });
    const res = await lock.acquire();
    expect(res.ok).toBe(true);
    expect(lock.isHeldBySelf()).toBe(false);
    expect(await exists(join(dir, "instance.lock"))).toBe(false);
  });

  test("降级：锁文件存在但 JSON 损坏 → 返回 warning 而非崩溃", async () => {
    await writeFile(join(dir, "instance.lock"), "not-json", "utf8");
    const lock = new FileLock({ dir, name: "instance" });
    const res = await lock.acquire();
    expect(res.ok).toBe(false);
    expect(res.warning).toContain("降级");
  });

  test("release 幂等：双 release 不抛", async () => {
    const lock = new FileLock({ dir, name: "instance" });
    await lock.acquire();
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  test("heartbeat 写失败降级：锁文件只读 → 记录降级且不抛错", async () => {
    const lock = new FileLock({ dir, name: "instance", heartbeatMs: 20 });
    const res = await lock.acquire();
    expect(res.ok).toBe(true);
    const lockPath = join(dir, "instance.lock");
    await chmod(lockPath, 0o444); // Windows 只读属性
    await new Promise<void>((resolve) => setTimeout(resolve, 80)); // 等多次心跳失败
    expect(lock.heartbeatFailed).toBe(true);
    await chmod(lockPath, 0o666); // 恢复可写，便于清理
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
