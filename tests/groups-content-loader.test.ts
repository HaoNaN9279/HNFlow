// 功能组内容加载器测试（v0.3.1 T1）：loadGroupContent 解析 agent/tools/rules/mcps 内容文件。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GroupContentLoadError, loadGroupContent, type LoadedGroupContent } from "../src/groups/content-loader.js";
import type { CapabilityGroup, GroupContent } from "../src/groups/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-content-loader-test";

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

/** 期望 promise 抛出 GroupContentLoadError 并返回错误实例（供断言 path/reason）。 */
async function expectLoadError(promise: Promise<LoadedGroupContent>): Promise<GroupContentLoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GroupContentLoadError) {
      return error;
    }
    throw new Error(`期望 GroupContentLoadError，实际抛出：${String(error)}`);
  }
  throw new Error("期望 GroupContentLoadError，但未抛出");
}

/** 构造合法 CapabilityGroup（content 由调用方指定）。 */
function makeGroup(content: GroupContent): CapabilityGroup {
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
        content,
      },
    ],
  };
}

/** 版本目录：root/web/scraping/playwright/v1.0.0。 */
function versionDir(root: string): string {
  return join(root, "web", "scraping", "playwright", "v1.0.0");
}

describe("loadGroupContent", () => {
  test("合法加载：agent/tools/rules/mcps 全齐 → 解析正确（含 frontmatter constraint）", async () => {
    const dir = versionDir(TEMP_BASE);
    await mkdir(join(dir, "tools"), { recursive: true });
    await mkdir(join(dir, "rules"), { recursive: true });
    await writeFile(join(dir, "agent.md"), "# Agent 定义\n抓取网页。", "utf8");
    await writeFile(
      join(dir, "tools", "read_file.json"),
      JSON.stringify({ name: "read_file", description: "读取文件内容", parameters: { type: "object", properties: {} } }),
      "utf8",
    );
    await writeFile(join(dir, "rules", "01-style.md"), "---\nconstraint: markdown\n---\n# 风格规则\n遵循项目惯例。", "utf8");
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ name: "mcp-server", command: "npx", args: ["@server"] }), "utf8");

    const loaded = await loadGroupContent(
      TEMP_BASE,
      makeGroup({
        agent: "agent.md",
        tools: ["tools/read_file.json"],
        mcps: ["mcp.json"],
        rules: [{ path: "rules/01-style.md", order: 1 }],
      }),
      "1.0.0",
    );

    expect(loaded.guid).toBe("g-playwright");
    expect(loaded.namespace).toBe("web/scraping/playwright");
    expect(loaded.version).toBe("1.0.0");
    expect(loaded.agent).toEqual({ text: "# Agent 定义\n抓取网页。" });
    expect(loaded.tools).toEqual([
      { name: "read_file", description: "读取文件内容", parameters: { type: "object", properties: {} }, path: "tools/read_file.json" },
    ]);
    expect(loaded.rules).toEqual([
      { path: "rules/01-style.md", order: 1, text: "---\nconstraint: markdown\n---\n# 风格规则\n遵循项目惯例。", constraint: "markdown" },
    ]);
    expect(loaded.mcps).toEqual([{ name: "mcp-server", config: { command: "npx", args: ["@server"] }, path: "mcp.json" }]);
  });

  test("agent 缺失：content 无 agent → agent 字段省略", async () => {
    const dir = versionDir(TEMP_BASE);
    await mkdir(join(dir, "rules"), { recursive: true });
    await writeFile(join(dir, "rules", "01.md"), "# 规则", "utf8");
    const loaded = await loadGroupContent(
      TEMP_BASE,
      makeGroup({ tools: [], mcps: [], rules: [{ path: "rules/01.md", order: 1 }] }),
      "1.0.0",
    );
    expect(loaded.agent).toBeUndefined();
  });

  test("tools JSON 非法 → GroupContentLoadError 含路径", async () => {
    const dir = versionDir(TEMP_BASE);
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", "bad.json"), "{ invalid json", "utf8");
    const error = await expectLoadError(
      loadGroupContent(TEMP_BASE, makeGroup({ tools: ["tools/bad.json"], mcps: [], rules: [] }), "1.0.0"),
    );
    expect(error.path).toContain("tools");
    expect(error.path).toContain("bad.json");
    expect(error.reason).toContain("JSON");
  });

  test("tools name 缺失 → GroupContentLoadError", async () => {
    const dir = versionDir(TEMP_BASE);
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(
      join(dir, "tools", "no-name.json"),
      JSON.stringify({ description: "缺 name 字段", parameters: { type: "object" } }),
      "utf8",
    );
    const error = await expectLoadError(
      loadGroupContent(TEMP_BASE, makeGroup({ tools: ["tools/no-name.json"], mcps: [], rules: [] }), "1.0.0"),
    );
    expect(error.path).toContain("no-name.json");
    expect(error.reason).toContain("name");
  });

  test("规则 frontmatter 解析：有 constraint / 无 constraint / 无 frontmatter", async () => {
    const dir = versionDir(TEMP_BASE);
    await mkdir(join(dir, "rules"), { recursive: true });
    await writeFile(join(dir, "rules", "01-with.md"), "---\nconstraint: json\n---\n# 有 constraint", "utf8");
    await writeFile(join(dir, "rules", "02-without.md"), "---\ntitle: 风格\n---\n# 无 constraint", "utf8");
    await writeFile(join(dir, "rules", "03-naked.md"), "# 无 frontmatter", "utf8");
    const loaded = await loadGroupContent(
      TEMP_BASE,
      makeGroup({
        tools: [],
        mcps: [],
        rules: [
          { path: "rules/01-with.md", order: 1 },
          { path: "rules/02-without.md", order: 2 },
          { path: "rules/03-naked.md", order: 3 },
        ],
      }),
      "1.0.0",
    );
    expect(loaded.rules).toHaveLength(3);
    expect(loaded.rules[0]?.constraint).toBe("json");
    expect(loaded.rules[1]?.constraint).toBeUndefined();
    expect(loaded.rules[2]?.constraint).toBeUndefined();
    expect(loaded.rules[1]?.text).toBe("---\ntitle: 风格\n---\n# 无 constraint");
  });

  test("mcp.json 解析：name + config 透传", async () => {
    const dir = versionDir(TEMP_BASE);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({ name: "browser-mcp", command: "npx", args: ["@browser"], env: { KEY: "val" } }),
      "utf8",
    );
    const loaded = await loadGroupContent(TEMP_BASE, makeGroup({ tools: [], mcps: ["mcp.json"], rules: [] }), "1.0.0");
    expect(loaded.mcps).toHaveLength(1);
    expect(loaded.mcps[0]?.name).toBe("browser-mcp");
    expect(loaded.mcps[0]?.config).toEqual({ command: "npx", args: ["@browser"], env: { KEY: "val" } });
    expect(loaded.mcps[0]?.path).toBe("mcp.json");
  });

  test("版本不存在 → GroupContentLoadError", async () => {
    const error = await expectLoadError(
      loadGroupContent(TEMP_BASE, makeGroup({ tools: [], mcps: [], rules: [] }), "9.9.9"),
    );
    expect(error.reason).toContain("9.9.9");
    expect(error.reason).toContain("不存在");
    expect(error.path).toContain("v9.9.9");
  });
});
