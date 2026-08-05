// 功能组全局索引库测试（v0.3.0 T3）：group_index / resource_registry 增查、幂等、文件库重复打开。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { openGroupIndex, type GroupIndexUpsert } from "../src/groups/index-store.js";
import type { ResourceEntry } from "../src/groups/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-index-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
});

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

/** 索引行数据（带 version 的 ResourceEntry，供 upsertResources）。 */
type IndexedResource = ResourceEntry & { readonly guid: string; readonly version: string };

interface GroupUpsertOverrides {
  readonly guid?: string;
  readonly namespace?: string;
  readonly currentVersion?: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly updatedAt?: number;
}

function makeGroupEntry(overrides: GroupUpsertOverrides = {}): GroupIndexUpsert {
  return {
    guid: "g-playwright",
    namespace: "web/scraping/playwright",
    currentVersion: "1.0.0",
    aliases: ["web/old-playwright"],
    description: "Playwright 抓取能力组",
    updatedAt: 1000,
    ...overrides,
  };
}

describe("openGroupIndex 内存库：group_index", () => {
  test("upsertGroup → getGroup 往返一致", async () => {
    const index = await openGroupIndex(":memory:");
    try {
      const entry = makeGroupEntry();
      await index.upsertGroup(entry);
      expect(await index.getGroup("g-playwright")).toEqual(entry);
      await expect(index.getGroup("no-such-guid")).resolves.toBeUndefined();
    } finally {
      await index.close();
    }
  });

  test("upsertGroup 同 guid 覆盖（upsert 语义）", async () => {
    const index = await openGroupIndex(":memory:");
    try {
      await index.upsertGroup(makeGroupEntry({ namespace: "web/scraping/playwright", updatedAt: 1000 }));
      await index.upsertGroup(makeGroupEntry({ namespace: "web/moved/playwright", updatedAt: 2000 }));
      expect(await index.listGroups()).toHaveLength(1);
      expect((await index.getGroup("g-playwright"))?.namespace).toBe("web/moved/playwright");
    } finally {
      await index.close();
    }
  });

  test("findByNamespace：namespace 命中 / aliases 命中 / 未命中 undefined", async () => {
    const index = await openGroupIndex(":memory:");
    try {
      await index.upsertGroup(makeGroupEntry());
      expect((await index.findByNamespace("web/scraping/playwright"))?.guid).toBe("g-playwright");
      expect((await index.findByNamespace("web/old-playwright"))?.guid).toBe("g-playwright");
      await expect(index.findByNamespace("no/such/namespace")).resolves.toBeUndefined();
    } finally {
      await index.close();
    }
  });

  test("listGroups 按 namespace 字典序排序", async () => {
    const index = await openGroupIndex(":memory:");
    try {
      await index.upsertGroup(makeGroupEntry({ guid: "g-z", namespace: "web/scraping/playwright", updatedAt: 2000 }));
      await index.upsertGroup(makeGroupEntry({ guid: "g-a", namespace: "data/validation", updatedAt: 1000 }));
      expect((await index.listGroups()).map((g) => g.namespace)).toEqual(["data/validation", "web/scraping/playwright"]);
    } finally {
      await index.close();
    }
  });
});

describe("openGroupIndex 内存库：resource_registry", () => {
  test("upsertResources 插入 + listResources 按 guid/version 过滤", async () => {
    const index = await openGroupIndex(":memory:");
    try {
      await index.upsertResources([
        { guid: "g-1", version: "1.0.0", type: "agent", name: "agent", path: "agent.md" },
        { guid: "g-1", version: "1.0.0", type: "tool", name: "navigate", path: "navigate.ts" },
        { guid: "g-1", version: "2.0.0", type: "tool", name: "navigate", path: "navigate.ts" },
        { guid: "g-2", version: "1.0.0", type: "rule", name: "r1", path: "rules/01.md" },
      ]);
      expect(await index.listResources("g-1", "1.0.0")).toHaveLength(2);
      expect((await index.listResources("g-1", "1.0.0")).map((r) => r.name)).toEqual(["agent", "navigate"]);
      expect(await index.listResources("g-1", "2.0.0")).toHaveLength(1);
      expect(await index.listResources("g-2", "1.0.0")).toHaveLength(1);
      expect(await index.listResources("g-2", "2.0.0")).toHaveLength(0);
    } finally {
      await index.close();
    }
  });

  test("唯一约束：同 (guid,version,type,name) 重复插入被 IGNORE 不抛错", async () => {
    const index = await openGroupIndex(":memory:");
    try {
      const dup: IndexedResource = { guid: "g-dup", version: "1.0.0", type: "tool", name: "navigate", path: "navigate.ts" };
      await index.upsertResources([dup]);
      await expect(index.upsertResources([dup])).resolves.toBeUndefined();
      await expect(index.upsertResources([dup, dup])).resolves.toBeUndefined();
      expect(await index.listResources("g-dup", "1.0.0")).toHaveLength(1);
    } finally {
      await index.close();
    }
  });
});

describe("openGroupIndex 文件库", () => {
  test("打开既有文件库：重复打开建表幂等不炸", async () => {
    const dbPath = nextDbPath("file");
    const first = await openGroupIndex(dbPath);
    await first.upsertGroup(makeGroupEntry());
    await first.close();

    const second = await openGroupIndex(dbPath);
    expect((await second.getGroup("g-playwright"))?.namespace).toBe("web/scraping/playwright");
    await second.close();

    // 再次打开既有库：ensureSchema 重复执行 CREATE TABLE IF NOT EXISTS，不抛错、数据保留。
    const third = await openGroupIndex(dbPath);
    expect(await third.listGroups()).toHaveLength(1);
    await third.close();
  });
});
