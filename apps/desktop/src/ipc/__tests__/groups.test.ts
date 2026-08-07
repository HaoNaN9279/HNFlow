// v0.4.3 功能组种子初始化 + 扫描汇总纯逻辑单测（无 electron，bun test 直跑）。
// 运行方式：apps/desktop 下 `bun test src/ipc/__tests__/groups.test.ts`。
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUP_LIB_DIR, ensureGroupLibrary, scanGroupsSummary } from "../groups.js";
import { SEED_GROUPS } from "../seed-groups.js";

/** 临时 userData 根目录（每个测试独立创建，测试后清理）。 */
let tempBase: string;

beforeEach(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "hnflow-groups-"));
});

afterEach(async () => {
  await rm(tempBase, { recursive: true, force: true });
});

describe("ensureGroupLibrary + scanGroupsSummary", () => {
  it("首启写种子 → 返回 4 组（demo + 三个领域组，按 namespace 字典序）", async () => {
    await ensureGroupLibrary(tempBase);
    const summaries = await scanGroupsSummary(join(tempBase, GROUP_LIB_DIR));
    expect(summaries).toHaveLength(4);
    // demo 不再位于 summaries[0]（按 namespace 字典序排序），改用 find 按 namespace 查找。
    const demo = summaries.find((summary) => summary.namespace === "demo");
    if (demo === undefined) return;
    expect(demo.namespace).toBe("demo");
    expect(demo.currentVersion).toBe("1.0.0");
    expect(demo.tools).toHaveLength(1);
    expect(demo.tools[0]?.name).toBe("echo_tool");
    expect(demo.tools[0]?.description).toBe("演示工具：回显文本");
    expect(demo.mcps).toHaveLength(0);
  });

  it("三个领域种子组写盘 → 汇总含各工具摘要，种子定义含规则", async () => {
    const seedNamespaces = ["web/scraping", "data/processing", "code/review"];
    for (const seed of SEED_GROUPS) {
      if (!seedNamespaces.includes(seed.namespace)) continue;
      const versionContent = seed.versionContent[seed.currentVersion];
      expect(versionContent?.tools.length ?? 0, `${seed.namespace} 工具数`).toBeGreaterThanOrEqual(2);
      expect(versionContent?.rules?.length ?? 0, `${seed.namespace} 规则数`).toBeGreaterThanOrEqual(1);
    }
    await ensureGroupLibrary(tempBase);
    const summaries = await scanGroupsSummary(join(tempBase, GROUP_LIB_DIR));
    for (const namespace of seedNamespaces) {
      const group = summaries.find((summary) => summary.namespace === namespace);
      if (group === undefined) return;
      expect(group.currentVersion).toBe("1.0.0");
      expect(group.tools.length, `${namespace} tools 摘要数`).toBeGreaterThanOrEqual(2);
      for (const tool of group.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
      }
      expect(group.mcps).toHaveLength(0);
    }
  });

  it("空 groups 目录 → 返回 []", async () => {
    await mkdir(join(tempBase, GROUP_LIB_DIR), { recursive: true });
    const summaries = await scanGroupsSummary(join(tempBase, GROUP_LIB_DIR));
    expect(summaries).toEqual([]);
  });

  it("自定义功能组（工具 + mcp.json）→ 汇总正确（含 mcp 配置）", async () => {
    const groupDir = join(tempBase, GROUP_LIB_DIR, "web", "scraping", "playwright");
    const versionDir = join(groupDir, "v1.0.0");
    await mkdir(join(versionDir, "tools"), { recursive: true });
    await writeFile(
      join(groupDir, "group.json"),
      JSON.stringify({
        guid: "11111111-2222-3333-4444-555555555555",
        namespace: "web/scraping/playwright",
        aliases: [],
        description: "爬虫功能组",
        currentVersion: "1.0.0",
        versions: [
          {
            version: "1.0.0",
            createdAt: "2026-08-01T00:00:00.000Z",
            changelog: "初版",
            content: { tools: ["tools/read_file.json"], mcps: ["mcp.json"], rules: [] },
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(versionDir, "tools", "read_file.json"),
      JSON.stringify({
        name: "read_file",
        description: "读取文件内容",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }),
      "utf8",
    );
    await writeFile(
      join(versionDir, "mcp.json"),
      JSON.stringify({ name: "echo-server", command: "bun", args: ["tests/fixtures/mcp/echo-server.ts"] }),
      "utf8",
    );
    const summaries = await scanGroupsSummary(join(tempBase, GROUP_LIB_DIR));
    expect(summaries).toHaveLength(1);
    const group = summaries[0];
    if (group === undefined) return;
    expect(group.namespace).toBe("web/scraping/playwright");
    expect(group.currentVersion).toBe("1.0.0");
    expect(group.tools[0]?.name).toBe("read_file");
    expect(group.tools[0]?.description).toBe("读取文件内容");
    expect(group.mcps[0]?.name).toBe("echo-server");
    expect(group.mcps[0]?.config).toEqual({ command: "bun", args: ["tests/fixtures/mcp/echo-server.ts"] });
  });
});
