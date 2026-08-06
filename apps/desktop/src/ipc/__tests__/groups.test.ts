// v0.4.3 功能组种子初始化 + 扫描汇总纯逻辑单测（无 electron，bun test 直跑）。
// 运行方式：apps/desktop 下 `bun test src/ipc/__tests__/groups.test.ts`。
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUP_LIB_DIR, ensureGroupLibrary, scanGroupsSummary } from "../groups.js";

/** 临时 userData 根目录（每个测试独立创建，测试后清理）。 */
let tempBase: string;

beforeEach(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "hnflow-groups-"));
});

afterEach(async () => {
  await rm(tempBase, { recursive: true, force: true });
});

describe("ensureGroupLibrary + scanGroupsSummary", () => {
  it("首启写种子 → 返回 demo 组（namespace=demo、含 echo_tool 声明、mcps 空）", async () => {
    await ensureGroupLibrary(tempBase);
    const summaries = await scanGroupsSummary(join(tempBase, GROUP_LIB_DIR));
    expect(summaries).toHaveLength(1);
    const demo = summaries[0];
    if (demo === undefined) return;
    expect(demo.namespace).toBe("demo");
    expect(demo.currentVersion).toBe("1.0.0");
    expect(demo.tools).toHaveLength(1);
    expect(demo.tools[0]?.name).toBe("echo_tool");
    expect(demo.tools[0]?.description).toBe("演示工具：回显文本");
    expect(demo.mcps).toHaveLength(0);
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
