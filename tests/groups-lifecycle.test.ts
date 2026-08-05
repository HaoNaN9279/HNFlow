// 功能组生命周期测试（v0.3.0 T2）：initGroup 创建 / releaseGroup 发布 / collectResources 扫描。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GroupFileError } from "../src/groups/errors.js";
import { initGroup } from "../src/groups/init.js";
import { loadGroup } from "../src/groups/load.js";
import { collectResources, releaseGroup } from "../src/groups/release.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-lifecycle-test";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 向指定版本目录写入相对路径文件（自动建父目录）。 */
async function writeVersionFile(
  namespace: string,
  version: string,
  relPath: string,
  content: string,
): Promise<void> {
  const filePath = join(TEMP_BASE, ...namespace.split("/"), `v${version}`, relPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("initGroup", () => {
  test("创建完整结构：目录 / group.json / v0.1.0 版本目录", async () => {
    const group = await initGroup(TEMP_BASE, "web/scraping/playwright");
    expect(group.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(group.namespace).toBe("web/scraping/playwright");
    expect(group.currentVersion).toBe("0.1.0");
    expect(group.versions[0]?.changelog).toBe("初始版本");
    expect(group.versions[0]?.content).toEqual({ tools: [], mcps: [], rules: [] });

    const groupDir = join(TEMP_BASE, "web", "scraping", "playwright");
    expect(await pathExists(join(groupDir, "group.json"))).toBe(true);
    expect(await pathExists(join(groupDir, "v0.1.0", "agent.md"))).toBe(true);
    expect((await stat(join(groupDir, "v0.1.0", "rules"))).isDirectory()).toBe(true);
    expect((await stat(join(groupDir, "v0.1.0", "tools"))).isDirectory()).toBe(true);
  });

  test("namespace 非法：抛 GroupFileError", async () => {
    for (const bad of ["", "/abc", "abc/", "a/../b", "a/./b", "a//b", "a b", "a\\b", "a:b"]) {
      await expect(initGroup(TEMP_BASE, bad)).rejects.toThrow(GroupFileError);
    }
  });

  test("namespace 已存在：抛 GroupFileError", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await expect(initGroup(TEMP_BASE, "demo/core")).rejects.toThrow(/已存在/);
  });

  test("返回对象可被 loadGroup 读回一致", async () => {
    const group = await initGroup(TEMP_BASE, "web/scraping/playwright");
    const loaded = await loadGroup(join(TEMP_BASE, "web", "scraping", "playwright"));
    expect(loaded).toEqual(group);
  });
});

describe("releaseGroup", () => {
  test("v1.0.0 发布：currentVersion 更新、versions 追加、版本目录内容拷贝", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await writeVersionFile("demo/core", "0.1.0", "rules/01-navigation.md", "# 导航规则");
    await writeVersionFile("demo/core", "0.1.0", "tools/navigate.ts", "export default {};");

    const released = await releaseGroup(TEMP_BASE, "demo/core", "1.0.0");
    expect(released.group.currentVersion).toBe("1.0.0");
    expect(released.group.versions).toHaveLength(2);
    expect(released.group.versions[1]?.version).toBe("1.0.0");

    const copied = await readFile(
      join(TEMP_BASE, "demo", "core", "v1.0.0", "rules", "01-navigation.md"),
      "utf8",
    );
    expect(copied).toBe("# 导航规则");
    expect(await pathExists(join(TEMP_BASE, "demo", "core", "v1.0.0", "tools", "navigate.ts"))).toBe(true);
  });

  test("功能组不存在：抛 GroupFileError", async () => {
    await expect(releaseGroup(TEMP_BASE, "no/such/group", "1.0.0")).rejects.toThrow(GroupFileError);
  });

  test("版本不递增（同版本 / 降级）：拒绝", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await expect(releaseGroup(TEMP_BASE, "demo/core", "0.1.0")).rejects.toThrow(GroupFileError);
    await releaseGroup(TEMP_BASE, "demo/core", "1.0.0");
    await expect(releaseGroup(TEMP_BASE, "demo/core", "0.5.0")).rejects.toThrow(/当前版本 "1.0.0"/);
  });

  test("同版本重发布：拒绝", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await releaseGroup(TEMP_BASE, "demo/core", "1.0.0");
    await expect(releaseGroup(TEMP_BASE, "demo/core", "1.0.0")).rejects.toThrow(GroupFileError);
  });

  test("changelog 落盘：显式值写入，缺省为「更新」", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await releaseGroup(TEMP_BASE, "demo/core", "1.0.0", "重大更新：新增批量抓取");
    await releaseGroup(TEMP_BASE, "demo/core", "2.0.0");
    const loaded = await loadGroup(join(TEMP_BASE, "demo", "core"));
    expect(loaded.versions[1]?.changelog).toBe("重大更新：新增批量抓取");
    expect(loaded.versions[2]?.changelog).toBe("更新");
  });

  test("版本内同名规则（不同扩展名）：拒绝发布并清理半成品目录", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await writeVersionFile("demo/core", "0.1.0", "rules/01-build.md", "a");
    await writeVersionFile("demo/core", "0.1.0", "rules/01-build.txt", "b");
    await expect(releaseGroup(TEMP_BASE, "demo/core", "0.2.0")).rejects.toThrow(/重复/);
    expect(await pathExists(join(TEMP_BASE, "demo", "core", "v0.2.0"))).toBe(false);
  });

  test("release 后 loadGroup 读回新版本 content 正确（扫描 + order）", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    await writeVersionFile("demo/core", "0.1.0", "rules/02-x.md", "x");
    await writeVersionFile("demo/core", "0.1.0", "rules/01-y.md", "y");
    await writeVersionFile("demo/core", "0.1.0", "tools/a.ts", "a");
    await writeVersionFile("demo/core", "0.1.0", "agent.md", "# 身份");
    await writeVersionFile("demo/core", "0.1.0", "mcp.json", "{}");

    await releaseGroup(TEMP_BASE, "demo/core", "1.0.0");
    const loaded = await loadGroup(join(TEMP_BASE, "demo", "core"));
    const content = loaded.versions[1]?.content;
    expect(content?.agent).toBe("agent.md");
    expect(content?.tools).toEqual(["tools/a.ts"]);
    expect(content?.mcps).toEqual(["mcp.json"]);
    expect(content?.rules).toEqual([
      { path: "rules/01-y.md", order: 1 },
      { path: "rules/02-x.md", order: 2 },
    ]);
  });

  test("requiresCoreVersion 与 dependencies 从上一版本继承", async () => {
    await initGroup(TEMP_BASE, "demo/core");
    const groupJsonPath = join(TEMP_BASE, "demo", "core", "group.json");
    const raw = JSON.parse(await readFile(groupJsonPath, "utf8")) as Record<string, unknown>;
    const versions = raw.versions as Array<Record<string, unknown>>;
    const content = versions[0]?.content as Record<string, unknown>;
    content.requiresCoreVersion = ">=1.0.0 <2.0.0";
    content.dependencies = [{ guid: "g-other", versionRange: ">=0.1.0 <1.0.0" }];
    await writeFile(groupJsonPath, JSON.stringify(raw), "utf8");

    await releaseGroup(TEMP_BASE, "demo/core", "1.0.0");
    const loaded = await loadGroup(join(TEMP_BASE, "demo", "core"));
    const newContent = loaded.versions[1]?.content;
    expect(newContent?.requiresCoreVersion).toBe(">=1.0.0 <2.0.0");
    expect(newContent?.dependencies).toEqual([{ guid: "g-other", versionRange: ">=0.1.0 <1.0.0" }]);
  });
});

describe("collectResources", () => {
  test("扫描版本目录生成资源登记项（agent/mcp/tools/rules）", async () => {
    const versionDir = join(TEMP_BASE, "web", "scraping", "playwright", "v1.0.0");
    await mkdir(join(versionDir, "tools"), { recursive: true });
    await mkdir(join(versionDir, "rules"), { recursive: true });
    await writeFile(join(versionDir, "agent.md"), "identity", "utf8");
    await writeFile(join(versionDir, "mcp.json"), "{}", "utf8");
    await writeFile(join(versionDir, "tools", "a.ts"), "a", "utf8");
    await writeFile(join(versionDir, "tools", "b.ts"), "b", "utf8");
    await writeFile(join(versionDir, "rules", "02-y.md"), "y", "utf8");
    await writeFile(join(versionDir, "rules", "01-x.md"), "x", "utf8");
    await writeFile(join(versionDir, "readme.md"), "not registered", "utf8");

    const resources = await collectResources(versionDir);
    expect(resources).toEqual([
      { type: "agent", name: "agent", path: "agent.md" },
      { type: "mcp", name: "mcp", path: "mcp.json" },
      { type: "tool", name: "a", path: "tools/a.ts" },
      { type: "tool", name: "b", path: "tools/b.ts" },
      { type: "rule", name: "01-x", path: "rules/01-x.md" },
      { type: "rule", name: "02-y", path: "rules/02-y.md" },
    ]);
  });
});
