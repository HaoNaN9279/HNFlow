// 运行时能力组加载器测试（v0.3.1 T4）：懒加载 + LRU 缓存复用 + 失败路径 + 批量回滚 + 缓存淘汰。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GroupLoadError, GroupRuntime } from "../src/groups/runtime.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-runtime-test";

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

/** 构造合法 group.json 数据（overrides 用于制造非法场景）。 */
function makeGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: "g-playwright",
    namespace: "web/scraping/playwright",
    aliases: [],
    description: "Playwright 抓取能力组",
    currentVersion: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: "初版",
        content: {
          agent: "agent.md",
          tools: ["navigate.ts"],
          mcps: ["mcp.json"],
          rules: [{ path: "rules/01-navigation.md", order: 1 }],
        },
      },
    ],
    ...overrides,
  };
}

async function writeGroupJson(dir: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "group.json"), JSON.stringify(data), "utf8");
}

/** 写入功能组定义 + 各版本目录实际内容文件（agent.md / navigate.ts / mcp.json / rules）。 */
async function writeGroup(base: string, guid: string, namespace: string, versions: string[]): Promise<void> {
  const firstVersion = versions[0];
  if (firstVersion === undefined) {
    throw new Error("writeGroup 至少需要一个版本");
  }
  const groupDir = join(base, ...namespace.split("/"));
  await writeGroupJson(
    groupDir,
    makeGroup({
      guid,
      namespace,
      currentVersion: firstVersion,
      versions: versions.map((version) => ({
        version,
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: `版本 ${version}`,
        content: {
          agent: "agent.md",
          tools: ["navigate.ts"],
          mcps: ["mcp.json"],
          rules: [{ path: "rules/01-navigation.md", order: 1 }],
        },
      })),
    }),
  );
  for (const version of versions) {
    const versionDir = join(groupDir, `v${version}`);
    await mkdir(join(versionDir, "rules"), { recursive: true });
    await writeFile(join(versionDir, "agent.md"), `# ${guid} agent ${version}\n`, "utf8");
    await writeFile(
      join(versionDir, "navigate.ts"),
      JSON.stringify({ name: "navigate", description: "导航能力", parameters: { type: "object" } }),
      "utf8",
    );
    await writeFile(
      join(versionDir, "mcp.json"),
      JSON.stringify({ name: "demo-mcp", url: "http://localhost:9999" }),
      "utf8",
    );
    await writeFile(join(versionDir, "rules", "01-navigation.md"), "# 导航规则\n", "utf8");
  }
}

describe("GroupRuntime 懒加载与缓存复用", () => {
  test("同 guid@version 第二次 load 命中缓存：diskReadCount 不增", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const content = await runtime.load("g-playwright", "1.0.0");
    expect(content.guid).toBe("g-playwright");
    expect(content.version).toBe("1.0.0");
    expect(content.agent?.text).toContain("g-playwright agent 1.0.0");
    expect(runtime.diskReadCount).toBe(1);
    expect(runtime.cacheSize).toBe(1);
    await runtime.load("g-playwright", "1.0.0");
    expect(runtime.diskReadCount).toBe(1); // 缓存命中，不读盘
  });

  test("loadMany 两个节点同组：diskReadCount=1（缓存复用）", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const contents = await runtime.loadMany([
      { guid: "g-playwright", version: "1.0.0" },
      { guid: "g-playwright", version: "1.0.0" },
    ]);
    expect(contents).toHaveLength(2);
    expect(runtime.diskReadCount).toBe(1);
    expect(runtime.cacheSize).toBe(1);
  });

  test("不同版本分开缓存：v1/v2 各读盘一次", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0", "2.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    await runtime.load("g-playwright", "1.0.0");
    await runtime.load("g-playwright", "2.0.0");
    expect(runtime.diskReadCount).toBe(2);
    expect(runtime.cacheSize).toBe(2);
  });
});

describe("GroupRuntime 失败路径", () => {
  test("guid 不存在：GroupLoadError 含 guid 与原因", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const promise = runtime.load("g-unknown", "1.0.0");
    await expect(promise).rejects.toBeInstanceOf(GroupLoadError);
    await expect(promise).rejects.toMatchObject({ guid: "g-unknown", version: "1.0.0" });
    await expect(promise).rejects.toThrow("功能组不存在");
  });

  test("版本不存在：GroupLoadError 含 guid 与版本", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const promise = runtime.load("g-playwright", "9.9.9");
    await expect(promise).rejects.toBeInstanceOf(GroupLoadError);
    await expect(promise).rejects.toMatchObject({ guid: "g-playwright", version: "9.9.9" });
    await expect(promise).rejects.toThrow("版本不存在");
  });

  test("group.json 缺失但存在其他组：GroupLoadError 含原因", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    await mkdir(join(TEMP_BASE, "ghost"), { recursive: true }); // 目录存在但无 group.json：scanGroups 跳过
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const promise = runtime.load("g-ghost", "1.0.0");
    await expect(promise).rejects.toBeInstanceOf(GroupLoadError);
    await expect(promise).rejects.toMatchObject({ guid: "g-ghost", version: "1.0.0" });
    await expect(promise).rejects.toThrow("功能组不存在");
  });

  test("guid 存在但内容文件缺失：GroupLoadError 转抛含原因", async () => {
    // group.json 声明 navigate.ts，但版本目录为空：loadGroupContent 抛 GroupContentLoadError
    const groupDir = join(TEMP_BASE, "web", "broken");
    await writeGroupJson(groupDir, makeGroup({ guid: "g-broken", namespace: "web/broken" }));
    await mkdir(join(groupDir, "v1.0.0"), { recursive: true });
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const promise = runtime.load("g-broken", "1.0.0");
    await expect(promise).rejects.toBeInstanceOf(GroupLoadError);
    await expect(promise).rejects.toMatchObject({ guid: "g-broken", version: "1.0.0" });
    await expect(promise).rejects.toThrow("文件不存在");
  });
});

describe("GroupRuntime 批量加载与缓存淘汰", () => {
  test("loadMany 第二项失败：抛错且前面成功的项不缓存（再 load 重新读盘）", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    await expect(
      runtime.loadMany([
        { guid: "g-playwright", version: "1.0.0" },
        { guid: "g-unknown", version: "1.0.0" },
      ]),
    ).rejects.toThrow(GroupLoadError);
    expect(runtime.cacheSize).toBe(0); // 前面成功的项已回滚，未缓存半成品
    const before = runtime.diskReadCount;
    await runtime.load("g-playwright", "1.0.0"); // 再 load 重新读盘
    expect(runtime.diskReadCount).toBe(before + 1);
  });

  test("缓存淘汰：cacheMaxSize=2 塞 3 个不同组，首个被淘汰后重新读盘（水位自动清理）", async () => {
    await writeGroup(TEMP_BASE, "g-a", "a", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-b", "b", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-c", "c", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 2 }); // 默认 watermark 0.8 → 阈值 1.6
    await runtime.load("g-a", "1.0.0");
    await runtime.load("g-b", "1.0.0");
    await runtime.load("g-c", "1.0.0");
    // 水位自动清理：cacheSize=2 即达水位（2 >= 2*0.8），load 淘汰 ceil(2/2)=1，cache 恒 1 项
    expect(runtime.cacheSize).toBe(1);
    expect(runtime.memoryStats.evictions).toBe(2);
    const before = runtime.diskReadCount; // 3 次读盘
    await runtime.load("g-a", "1.0.0"); // g-a 已被自动清理淘汰，重新读盘
    expect(runtime.diskReadCount).toBe(before + 1);
  });
});

describe("GroupRuntime 水位线（watermark）与内存压力", () => {
  test("cacheMaxSize=4 watermark=0.5 加载 3 个组：cacheSize<4 且 evictions>0", async () => {
    await writeGroup(TEMP_BASE, "g-a", "a", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-b", "b", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-c", "c", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 4, watermark: 0.5 });
    await runtime.load("g-a", "1.0.0");
    await runtime.load("g-b", "1.0.0");
    await runtime.load("g-c", "1.0.0");
    // 阈值 = 4*0.5 = 2：第二个组达到水位触发 load 自动清理（淘汰 ceil(2/2)=1），此后 cache 恒 1 项
    expect(runtime.cacheSize).toBeLessThan(4);
    expect(runtime.memoryStats.evictions).toBeGreaterThan(0);
  });

  test("未超水位：evictions=0", async () => {
    await writeGroup(TEMP_BASE, "g-a", "a", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-b", "b", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 4, watermark: 1.0 });
    await runtime.load("g-a", "1.0.0");
    await runtime.load("g-b", "1.0.0");
    expect(runtime.memoryStats.evictions).toBe(0);
    expect(runtime.cacheSize).toBe(2);
  });

  test("memoryStats 字段完整 + 低水位压力为 low", async () => {
    await writeGroup(TEMP_BASE, "g-a", "a", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-b", "b", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 4, watermark: 0.5 });
    await runtime.load("g-a", "1.0.0");
    expect(runtime.memoryStats).toEqual({
      cacheSize: 1,
      capacity: 4,
      watermark: 0.5,
      pressure: "low",
      diskReadCount: 1,
      evictions: 0,
    });
    // 第二组使 cacheSize=2 达到水位（2 >= 4*0.5），load 自动清理淘汰一半 → 1 项
    await runtime.load("g-b", "1.0.0");
    expect(runtime.memoryStats).toEqual({
      cacheSize: 1,
      capacity: 4,
      watermark: 0.5,
      pressure: "low",
      diskReadCount: 2,
      evictions: 1,
    });
  });

  test("非法 watermark（0 / 负数 / >1 / NaN / Infinity）→ RangeError", () => {
    for (const w of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 4, watermark: w })).toThrow(RangeError);
    }
  });

  test("evictIdleCache：未超水位返回 0 且 evictions 不增", async () => {
    // 注：load 内自动清理（cacheSize >= 水位时淘汰 ceil(size/2)）使缓存恒低于水位，
    // 因此经公开 API 观测不到超水位状态，evictIdleCache 恒返回 0（load 自动清理已覆盖淘汰路径）。
    await writeGroup(TEMP_BASE, "g-a", "a", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-b", "b", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 4, watermark: 0.5 });
    await runtime.load("g-a", "1.0.0");
    expect(runtime.evictIdleCache()).toBe(0);
    expect(runtime.memoryStats.evictions).toBe(0);
    await runtime.load("g-b", "1.0.0"); // 触发 load 自动清理
    expect(runtime.memoryStats.evictions).toBe(1);
    expect(runtime.evictIdleCache()).toBe(0);
    expect(runtime.memoryStats.evictions).toBe(1);
  });

  test("清理后重新 load 正确：被淘汰的组重新读盘且内容正确", async () => {
    await writeGroup(TEMP_BASE, "g-a", "a", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-b", "b", ["1.0.0"]);
    await writeGroup(TEMP_BASE, "g-c", "c", ["1.0.0"]);
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE, cacheMaxSize: 4, watermark: 0.5 });
    await runtime.load("g-a", "1.0.0");
    await runtime.load("g-b", "1.0.0");
    await runtime.load("g-c", "1.0.0");
    expect(runtime.memoryStats.evictions).toBeGreaterThan(0);
    const before = runtime.diskReadCount;
    const content = await runtime.load("g-a", "1.0.0"); // g-a 已被 load 自动清理淘汰
    expect(content.guid).toBe("g-a");
    expect(content.agent?.text).toContain("g-a agent 1.0.0");
    expect(runtime.diskReadCount).toBe(before + 1);
  });
});
