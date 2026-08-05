// 功能组存储加载测试（v0.3.0 T1）：group.json 加载/校验、目录扫描、查找、语义版本。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GroupFileError, GroupScanError, SemanticVersionError } from "../src/groups/errors.js";
import { findGroup, findGroupByGuid, loadGroup, loadVersion, scanGroups } from "../src/groups/load.js";
import { compareSemVer, parseSemVer } from "../src/groups/semver.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-store-test";

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
    aliases: ["web/old-playwright"],
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

describe("loadGroup", () => {
  test("合法 group.json：返回完整 CapabilityGroup", async () => {
    const dir = join(TEMP_BASE, "web", "scraping", "playwright");
    await writeGroupJson(dir, makeGroup());
    const group = await loadGroup(dir);
    expect(group.guid).toBe("g-playwright");
    expect(group.namespace).toBe("web/scraping/playwright");
    expect(group.aliases).toEqual(["web/old-playwright"]);
    expect(group.currentVersion).toBe("1.0.0");
    expect(group.versions).toHaveLength(1);
    expect(group.versions[0]?.content.tools).toEqual(["navigate.ts"]);
    expect(group.versions[0]?.content.rules[0]?.order).toBe(1);
  });

  test("group.json 缺失：抛 GroupFileError", async () => {
    const dir = join(TEMP_BASE, "missing");
    await mkdir(dir, { recursive: true });
    await expect(loadGroup(dir)).rejects.toThrow(GroupFileError);
  });

  test("JSON 非法：抛 GroupFileError", async () => {
    const dir = join(TEMP_BASE, "bad-json");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "group.json"), "{ not valid json", "utf8");
    await expect(loadGroup(dir)).rejects.toThrow(GroupFileError);
  });

  test("字段缺失（versions 缺失）：抛 GroupFileError", async () => {
    const dir = join(TEMP_BASE, "no-versions");
    const { versions: _ignored, ...rest } = makeGroup();
    await writeGroupJson(dir, rest);
    await expect(loadGroup(dir)).rejects.toThrow(GroupFileError);
  });

  test("currentVersion 不在 versions：抛 GroupFileError", async () => {
    const dir = join(TEMP_BASE, "stale-current");
    await writeGroupJson(dir, makeGroup({ currentVersion: "9.9.9" }));
    await expect(loadGroup(dir)).rejects.toThrow(/currentVersion/);
  });

  test("aliases 元素非字符串：抛 GroupFileError", async () => {
    const dir = join(TEMP_BASE, "bad-aliases");
    await writeGroupJson(dir, makeGroup({ aliases: ["ok", 42] }));
    await expect(loadGroup(dir)).rejects.toThrow(GroupFileError);
  });
});

describe("scanGroups", () => {
  test("多层目录：正确识别 namespace 并按字典序排序", async () => {
    await writeGroupJson(join(TEMP_BASE, "data", "validation"), makeGroup({ guid: "g-validation", namespace: "data/validation" }));
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    const groups = await scanGroups(TEMP_BASE);
    expect(groups.map((g) => g.namespace)).toEqual(["data/validation", "web/scraping/playwright"]);
  });

  test("无 group.json 的分组目录：跳过但继续下钻", async () => {
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    await writeGroupJson(join(TEMP_BASE, "code", "review"), makeGroup({ guid: "g-review", namespace: "code/review" }));
    const groups = await scanGroups(TEMP_BASE);
    expect(groups.map((g) => g.namespace)).toEqual(["code/review", "web/scraping/playwright"]);
  });

  test("损坏的 group.json：警告并跳过，不中断其他组", async () => {
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    const badDir = join(TEMP_BASE, "broken");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "group.json"), "corrupted", "utf8");
    const warn = spyOn(console, "warn");
    try {
      const groups = await scanGroups(TEMP_BASE);
      expect(groups.map((g) => g.namespace)).toEqual(["web/scraping/playwright"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("rootDir 不存在：抛 GroupScanError", async () => {
    await expect(scanGroups(join(TEMP_BASE, "nope"))).rejects.toThrow(GroupScanError);
  });

  test("namespace 与目录路径不一致：以 group.json 为准并警告", async () => {
    const dir = join(TEMP_BASE, "web", "moved");
    await writeGroupJson(dir, makeGroup()); // namespace 仍为 web/scraping/playwright
    const warn = spyOn(console, "warn");
    try {
      const groups = await scanGroups(TEMP_BASE);
      expect(groups[0]?.namespace).toBe("web/scraping/playwright");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("findGroup / findGroupByGuid", () => {
  test("findGroup 按 namespace 命中", async () => {
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    const group = await findGroup(TEMP_BASE, "web/scraping/playwright");
    expect(group?.guid).toBe("g-playwright");
  });

  test("findGroup 按 aliases 命中", async () => {
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    const group = await findGroup(TEMP_BASE, "web/old-playwright");
    expect(group?.guid).toBe("g-playwright");
  });

  test("findGroup 未命中返回 undefined", async () => {
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    await expect(findGroup(TEMP_BASE, "no/such/group")).resolves.toBeUndefined();
  });

  test("findGroupByGuid 命中 / 未命中", async () => {
    await writeGroupJson(join(TEMP_BASE, "web", "scraping", "playwright"), makeGroup());
    expect((await findGroupByGuid(TEMP_BASE, "g-playwright"))?.namespace).toBe("web/scraping/playwright");
    await expect(findGroupByGuid(TEMP_BASE, "g-unknown")).resolves.toBeUndefined();
  });
});

describe("loadVersion", () => {
  test("按版本号取版本快照，未命中返回 undefined", async () => {
    const dir = join(TEMP_BASE, "web", "scraping", "playwright");
    await writeGroupJson(dir, makeGroup());
    const group = await loadGroup(dir);
    expect(loadVersion(group, "1.0.0")?.changelog).toBe("初版");
    expect(loadVersion(group, "2.0.0")).toBeUndefined();
  });
});

describe("parseSemVer / compareSemVer", () => {
  test("parseSemVer 合法：解析三段", () => {
    expect(parseSemVer("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  test("parseSemVer 非法：抛 SemanticVersionError", () => {
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "", "1.x.3"]) {
      expect(() => parseSemVer(bad)).toThrow(SemanticVersionError);
    }
  });

  test("compareSemVer 排序", () => {
    expect(compareSemVer(parseSemVer("1.2.3"), parseSemVer("1.2.4"))).toBe(-1);
    expect(compareSemVer(parseSemVer("1.2.3"), parseSemVer("1.2.3"))).toBe(0);
    expect(compareSemVer(parseSemVer("2.0.0"), parseSemVer("1.9.9"))).toBe(1);
  });
});
