// LRU 缓存测试（v0.3.1 T3）：泛型最近最少使用淘汰。
// 本测试纯内存不碰文件，但保持 Windows 清理惯例：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { LRUCache } from "../src/groups/lru-cache.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-lru-test";

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试（Windows 惯例）。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows 句柄释放依赖 GC，强制回收以解锁文件
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

describe("LRUCache", () => {
  test("基础 get/set/peek/has/size", () => {
    const cache = new LRUCache<string, number>();
    expect(cache.size).toBe(0);
    expect(cache.capacity).toBe(32); // 默认容量 32

    cache.set("a", 1);
    expect(cache.size).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.peek("a")).toBe(1);
    expect(cache.get("a")).toBe(1);

    expect(cache.get("missing")).toBeUndefined();
    expect(cache.peek("missing")).toBeUndefined();
    expect(cache.has("missing")).toBe(false);
  });

  test("容量淘汰：maxSize=3 塞 4 个 → 第 1 个被淘汰", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);

    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false); // 最久未用的 a 被淘汰
    expect(cache.peek("b")).toBe(2);
    expect(cache.peek("c")).toBe(3);
    expect(cache.peek("d")).toBe(4);
  });

  test("访问刷新：get 中间元素后塞满 → 最久未用的是未访问的", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    cache.get("a"); // 刷新 a 到最新，b 变为最久未用
    cache.set("d", 4); // 超容量，淘汰 b

    expect(cache.has("a")).toBe(true); // 刚访问的 a 保留
    expect(cache.has("b")).toBe(false); // 未访问的 b 被淘汰
    expect(cache.peek("c")).toBe(3);
    expect(cache.peek("d")).toBe(4);
  });

  test("set 已存在 key 刷新访问序（不增加 size）", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    cache.set("a", 10); // 更新 a 并刷新访问序
    expect(cache.size).toBe(3);
    expect(cache.peek("a")).toBe(10);

    cache.set("d", 4); // 此时 b 是最久未用
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.peek("a")).toBe(10);
  });

  test("delete / clear", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false); // 已删除
    expect(cache.size).toBe(1);
    expect(cache.has("a")).toBe(false);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has("b")).toBe(false);
  });

  test("非法 maxSize（0 / 负数 / 非整数）→ RangeError", () => {
    expect(() => new LRUCache(0)).toThrow(RangeError);
    expect(() => new LRUCache(-1)).toThrow(RangeError);
    expect(() => new LRUCache(1.5)).toThrow(RangeError);
  });

  test("泛型：string key + object value 可用", () => {
    type GroupVersion = { guid: string; version: string; content: string };
    const cache = new LRUCache<string, GroupVersion>(2);
    const v1 = { guid: "g-playwright", version: "1.0.0", content: "agent" };
    const v2 = { guid: "g-playwright", version: "1.1.0", content: "agent+v1" };
    const v3 = { guid: "g-other", version: "1.0.0", content: "tools" };

    cache.set("g-playwright@1.0.0", v1);
    cache.set("g-playwright@1.1.0", v2);
    cache.set("g-other@1.0.0", v3); // 淘汰 g-playwright@1.0.0

    expect(cache.peek("g-playwright@1.1.0")?.content).toBe("agent+v1");
    expect(cache.peek("g-other@1.0.0")?.content).toBe("tools");
    expect(cache.peek("g-playwright@1.0.0")).toBeUndefined();
  });

  test("evict：非正整数（0/负数/小数）返回 0 且不删", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.evict(0)).toBe(0);
    expect(cache.evict(-2)).toBe(0);
    expect(cache.evict(1.5)).toBe(0);
    expect(cache.size).toBe(2);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
  });

  test("evict：塞 3 个 evict(2) 返回 2 剩 1（从最旧开始删）", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.evict(2)).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.peek("c")).toBe(3);
  });

  test("evict：超量清空并返回原 size；空缓存返回 0", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.evict(10)).toBe(3); // 不足 count，全部删除
    expect(cache.size).toBe(0);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(false);
    expect(cache.evict(1)).toBe(0); // 空缓存：无可淘汰
  });

  test("evict 访问序：get(A) 后 evict(1) 淘汰最旧而非 A", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // a 刷新到最新访问序，b 变为最旧
    expect(cache.evict(1)).toBe(1);
    expect(cache.has("b")).toBe(false); // 淘汰最久未用的 b
    expect(cache.has("a")).toBe(true); // 刚访问的 a 保留
    expect(cache.has("c")).toBe(true);
  });
});
