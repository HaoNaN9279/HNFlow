// 安全漏洞版本强制升级引导测试（v0.9.5）：group.json schema 兼容 / GroupRuntime.load 阻止 / scanGroupsSummary 透出。
// scanGroupsSummary 位于 apps/desktop（package.json type=commonjs，root tsconfig 开 verbatimModuleSyntax，
// 静态 import 会把 apps/desktop 拉进 root tsc program 报 TS1295），故此处用 file URL 动态 import，tsc 不追踪路径。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGroup } from "../src/groups/load.js";
import { GroupLoadError, GroupRuntime } from "../src/groups/runtime.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-security-advisory-test";

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

/** 构造 group.json 数据；namespace 与写入目录须一致；securityAdvisory 传 undefined 则不写该字段（模拟旧数据）。 */
function makeGroup(options: { readonly guid?: string; readonly namespace?: string; readonly securityAdvisory?: string | undefined } = {}): Record<string, unknown> {
  return {
    guid: options.guid ?? "g-sec",
    namespace: options.namespace ?? "web/security",
    aliases: [],
    description: "安全测试功能组",
    currentVersion: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: "初版",
        ...(options.securityAdvisory === undefined ? {} : { securityAdvisory: options.securityAdvisory }),
        content: {
          agent: "agent.md",
          tools: ["navigate.ts"],
          mcps: ["mcp.json"],
          rules: [{ path: "rules/01-navigation.md", order: 1 }],
        },
      },
    ],
  };
}

async function writeGroupJson(dir: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "group.json"), JSON.stringify(data), "utf8");
}

/** 写版本目录实际内容文件（GroupRuntime.load / scanGroupsSummary 的内容加载需要）。 */
async function writeVersionFiles(dir: string, version: string): Promise<void> {
  const versionDir = join(dir, `v${version}`);
  await mkdir(join(versionDir, "rules"), { recursive: true });
  await writeFile(join(versionDir, "agent.md"), "# 安全测试 agent\n", "utf8");
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

/** apps/desktop/src/ipc/groups.js 的模块形状（仅取 scanGroupsSummary，避免静态 import 拉入 root tsc program）。 */
interface DesktopGroupsModule {
  readonly scanGroupsSummary: (
    groupsRootDir: string,
  ) => Promise<
    readonly { readonly namespace: string; readonly currentVersion: string; readonly securityAdvisory?: string }[]
  >;
}

/** 动态加载 apps/desktop 的 scanGroupsSummary（file URL 字符串，tsc 不追踪路径）。 */
async function loadDesktopGroupsModule(): Promise<DesktopGroupsModule> {
  const desktopGroupsUrl = new URL("../apps/desktop/src/ipc/groups.js", import.meta.url);
  return (await import(desktopGroupsUrl.href)) as DesktopGroupsModule;
}

describe("group.json schema 兼容 securityAdvisory", () => {
  test("带 securityAdvisory 的 group.json 可加载且字段保留", async () => {
    const groupDir = join(TEMP_BASE, "web", "security");
    await writeGroupJson(groupDir, makeGroup({ securityAdvisory: "存在命令注入漏洞（CVE-2026-0001），请升级到 2.0.0" }));
    const group = await loadGroup(groupDir);
    expect(group.versions[0]?.securityAdvisory).toBe("存在命令注入漏洞（CVE-2026-0001），请升级到 2.0.0");
  });

  test("旧数据（无 securityAdvisory 字段）可加载，字段为 undefined 且不写键", async () => {
    const groupDir = join(TEMP_BASE, "web", "legacy");
    await writeGroupJson(groupDir, makeGroup({ namespace: "web/legacy" })); // 不写 securityAdvisory，模拟旧数据
    const group = await loadGroup(groupDir);
    const first = group.versions[0];
    if (first === undefined) return;
    expect(first.securityAdvisory).toBeUndefined();
    expect("securityAdvisory" in first).toBe(false);
  });
});

describe("GroupRuntime.load 安全漏洞版本阻止", () => {
  test("securityAdvisory 版本抛 GroupLoadError：消息含 guid@version 与漏洞描述，且不缓存", async () => {
    const groupDir = join(TEMP_BASE, "web", "security");
    await writeGroupJson(groupDir, makeGroup({ securityAdvisory: "存在命令注入漏洞，请升级到 2.0.0" }));
    await writeVersionFiles(groupDir, "1.0.0");
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const promise = runtime.load("g-sec", "1.0.0");
    await expect(promise).rejects.toBeInstanceOf(GroupLoadError);
    await expect(promise).rejects.toMatchObject({ guid: "g-sec", version: "1.0.0" });
    await expect(promise).rejects.toThrow("版本存在安全漏洞，请升级：存在命令注入漏洞，请升级到 2.0.0");
    expect(runtime.cacheSize).toBe(0); // 被阻止的版本不进入缓存
  });

  test("无 advisory 版本正常加载", async () => {
    const groupDir = join(TEMP_BASE, "web", "safe");
    await writeGroupJson(groupDir, makeGroup({ namespace: "web/safe" }));
    await writeVersionFiles(groupDir, "1.0.0");
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const content = await runtime.load("g-sec", "1.0.0");
    expect(content.guid).toBe("g-sec");
    expect(content.version).toBe("1.0.0");
  });

  test("loadMany 含 advisory 版本：整体抛错且已加载项回滚缓存（Oracle MINOR 回归）", async () => {
    // 组 A（g-safe，无 advisory）：先加载成功进缓存。
    const safeDir = join(TEMP_BASE, "web", "safe");
    await writeGroupJson(safeDir, makeGroup({ guid: "g-safe", namespace: "web/safe" }));
    await writeVersionFiles(safeDir, "1.0.0");
    // 组 B（g-sec，有 advisory）：load 抛错。
    const secDir = join(TEMP_BASE, "web", "security");
    await writeGroupJson(secDir, makeGroup({ securityAdvisory: "存在命令注入漏洞，请升级到 2.0.0" }));
    await writeVersionFiles(secDir, "1.0.0");
    const runtime = new GroupRuntime({ rootDir: TEMP_BASE });
    const promise = runtime.loadMany([
      { guid: "g-safe", version: "1.0.0" },
      { guid: "g-sec", version: "1.0.0" },
    ]);
    await expect(promise).rejects.toBeInstanceOf(GroupLoadError);
    await expect(promise).rejects.toMatchObject({ guid: "g-sec", version: "1.0.0" });
    expect(runtime.cacheSize).toBe(0); // 前面成功的 g-safe 被回滚，不残留半成品缓存
  });
});

describe("scanGroupsSummary 透出 securityAdvisory", () => {
  test("advisory 存在时 GroupSummary.securityAdvisory 有值", async () => {
    const groupDir = join(TEMP_BASE, "web", "security");
    await writeGroupJson(groupDir, makeGroup({ securityAdvisory: "存在命令注入漏洞，请升级到 2.0.0" }));
    await writeVersionFiles(groupDir, "1.0.0");
    const module = await loadDesktopGroupsModule();
    const summaries = await module.scanGroupsSummary(TEMP_BASE);
    expect(summaries).toHaveLength(1);
    const group = summaries[0];
    if (group === undefined) return;
    expect(group.securityAdvisory).toBe("存在命令注入漏洞，请升级到 2.0.0");
  });

  test("无 advisory 时 GroupSummary.securityAdvisory 为 undefined 且不写键", async () => {
    const groupDir = join(TEMP_BASE, "web", "legacy");
    await writeGroupJson(groupDir, makeGroup({ namespace: "web/legacy" }));
    await writeVersionFiles(groupDir, "1.0.0");
    const module = await loadDesktopGroupsModule();
    const summaries = await module.scanGroupsSummary(TEMP_BASE);
    const group = summaries[0];
    if (group === undefined) return;
    expect(group.securityAdvisory).toBeUndefined();
    expect("securityAdvisory" in group).toBe(false);
  });
});
