// 功能组导出测试（v0.9.1 T3）：collectVersionFiles / buildGroupPackage / exportGroupPackage 三函数覆盖。
// 包格式契约：format/formatVersion/exportedAt/group/files（v<version>/ 前缀路径 → base64）；版本目录缺失跳过不抛错。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildGroupPackage,
  collectVersionFiles,
  exportGroupPackage,
  type GroupPackage,
} from "../src/groups/export.js";
import { groupJsonSchema } from "../src/groups/load.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-export-test";

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

/** 版本内容文件：相对版本目录路径 → 内容。 */
interface VersionFile {
  readonly relPath: string;
  readonly content: string;
}

/** 构造单个版本条目（content 声明与默认文件布局一致）。 */
function versionEntry(version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    createdAt: "2026-08-01T00:00:00.000Z",
    changelog: `版本 ${version}`,
    content: {
      agent: "agent.md",
      tools: ["tools/read_file.json"],
      mcps: ["mcp.json"],
      rules: [{ path: "rules/01-navigation.md", order: 1 }],
    },
    ...overrides,
  };
}

/** 构造合法 group.json 数据（overrides 用于多版本 / 废弃标记等场景）。 */
function makeGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: "g-playwright",
    namespace: "web/scraping/playwright",
    aliases: [],
    description: "Playwright 抓取能力组",
    currentVersion: "1.0.0",
    versions: [versionEntry("1.0.0")],
    ...overrides,
  };
}

/** 默认版本内容文件（agent + tool + mcp + rule，内容含版本号便于区分）。 */
function defaultVersionFiles(version: string): readonly VersionFile[] {
  return [
    { relPath: "agent.md", content: `# Agent ${version}\n抓取网页。` },
    {
      relPath: "tools/read_file.json",
      content: JSON.stringify({ name: "read_file", description: "读取文件", parameters: { type: "object" } }),
    },
    { relPath: "mcp.json", content: JSON.stringify({ name: "demo-mcp", url: "http://localhost:9999" }) },
    { relPath: "rules/01-navigation.md", content: `# 导航规则 ${version}\n` },
  ];
}

/** 写入功能组：group.json + 各版本目录内容文件（filesByVersion 缺版本 → 不建目录，模拟版本目录缺失）。 */
async function writeGroup(
  base: string,
  namespace: string,
  data: Record<string, unknown>,
  filesByVersion: Readonly<Record<string, readonly VersionFile[]>>,
): Promise<void> {
  const groupDir = join(base, ...namespace.split("/"));
  await mkdir(groupDir, { recursive: true });
  await writeFile(join(groupDir, "group.json"), JSON.stringify(data), "utf8");
  for (const [version, files] of Object.entries(filesByVersion)) {
    const versionDir = join(groupDir, `v${version}`);
    for (const file of files) {
      const abs = join(versionDir, ...file.relPath.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, "utf8");
    }
  }
}

/** 解码包内 base64 文件；缺失抛错（断言辅助）。 */
function decodeFile(pkg: GroupPackage, path: string): string {
  const encoded = pkg.files[path];
  if (encoded === undefined) {
    throw new Error(`包中缺少文件：${path}`);
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

describe("exportGroupPackage 基本导出", () => {
  test("包 format/formatVersion/exportedAt 正确 + group 元数据完整", async () => {
    await writeGroup(TEMP_BASE, "web/scraping/playwright", makeGroup(), { "1.0.0": defaultVersionFiles("1.0.0") });
    const dest = join(TEMP_BASE, "out", "playwright.hnflow-group");
    const pkg = await exportGroupPackage(TEMP_BASE, "web/scraping/playwright", dest);

    expect(pkg.format).toBe("hnflow-group");
    expect(pkg.formatVersion).toBe(1);
    expect(new Date(pkg.exportedAt).toISOString()).toBe(pkg.exportedAt); // ISO-8601 合法
    expect(pkg.group.guid).toBe("g-playwright");
    expect(pkg.group.namespace).toBe("web/scraping/playwright");
    expect(pkg.group.currentVersion).toBe("1.0.0");
    expect(pkg.group.versions).toHaveLength(1);
    expect(pkg.group.versions[0]?.version).toBe("1.0.0");
    expect(pkg.group.versions[0]?.content.tools).toEqual(["tools/read_file.json"]);
  });

  test("files 覆盖 agent/tool/mcp/rule：路径 posix + base64 解码后内容一致", async () => {
    const files = defaultVersionFiles("1.0.0");
    await writeGroup(TEMP_BASE, "web/scraping/playwright", makeGroup(), { "1.0.0": files });
    const pkg = await exportGroupPackage(TEMP_BASE, "web/scraping/playwright", join(TEMP_BASE, "out", "p.hnflow-group"));

    expect(Object.keys(pkg.files).sort()).toEqual([
      "v1.0.0/agent.md",
      "v1.0.0/mcp.json",
      "v1.0.0/rules/01-navigation.md",
      "v1.0.0/tools/read_file.json",
    ]);
    for (const file of files) {
      expect(decodeFile(pkg, `v1.0.0/${file.relPath}`)).toBe(file.content);
    }
  });

  test("多版本（v1.0.0 + v1.1.0）：files 含两版本，deprecated 标记原样保留", async () => {
    await writeGroup(
      TEMP_BASE,
      "web/scraping/playwright",
      makeGroup({
        currentVersion: "1.1.0",
        versions: [versionEntry("1.0.0", { deprecated: true }), versionEntry("1.1.0")],
      }),
      {
        "1.0.0": defaultVersionFiles("1.0.0"),
        "1.1.0": defaultVersionFiles("1.1.0"),
      },
    );
    const pkg = await exportGroupPackage(TEMP_BASE, "web/scraping/playwright", join(TEMP_BASE, "out", "p.hnflow-group"));

    expect(pkg.group.versions).toHaveLength(2);
    expect(pkg.group.versions[0]?.deprecated).toBe(true);
    expect(pkg.group.versions[1]?.deprecated).toBeUndefined();
    expect(decodeFile(pkg, "v1.0.0/agent.md")).toBe("# Agent 1.0.0\n抓取网页。");
    expect(decodeFile(pkg, "v1.1.0/agent.md")).toBe("# Agent 1.1.0\n抓取网页。");
    expect(Object.keys(pkg.files).some((path) => path.startsWith("v1.1.0/"))).toBe(true);
  });
});

describe("exportGroupPackage 容错与写入", () => {
  test("版本目录缺失：跳过该版本不抛错，files 不含缺失版本", async () => {
    await writeGroup(
      TEMP_BASE,
      "web/scraping/playwright",
      makeGroup({
        currentVersion: "1.1.0",
        versions: [versionEntry("1.0.0"), versionEntry("1.1.0")],
      }),
      { "1.0.0": defaultVersionFiles("1.0.0") }, // 缺 v1.1.0/ 目录
    );
    const pkg = await exportGroupPackage(TEMP_BASE, "web/scraping/playwright", join(TEMP_BASE, "out", "p.hnflow-group"));

    expect(Object.keys(pkg.files)).not.toContain("v1.1.0/agent.md");
    expect(decodeFile(pkg, "v1.0.0/agent.md")).toBe("# Agent 1.0.0\n抓取网页。");
  });

  test("功能组不存在：抛 GroupFileError（含 namespace）", async () => {
    await writeGroup(TEMP_BASE, "web/scraping/playwright", makeGroup(), { "1.0.0": defaultVersionFiles("1.0.0") });
    const promise = exportGroupPackage(TEMP_BASE, "not/exist", join(TEMP_BASE, "out", "p.hnflow-group"));
    await expect(promise).rejects.toThrow("功能组不存在");
  });

  test("导出文件实际写入 destFile：JSON 可解析，group 元数据过 load.ts schema 校验", async () => {
    await writeGroup(TEMP_BASE, "web/scraping/playwright", makeGroup(), { "1.0.0": defaultVersionFiles("1.0.0") });
    const dest = join(TEMP_BASE, "out", "playwright.hnflow-group");
    const pkg = await exportGroupPackage(TEMP_BASE, "web/scraping/playwright", dest);

    const raw = await readFile(dest, "utf8");
    const parsed = JSON.parse(raw) as GroupPackage;
    expect(parsed.format).toBe("hnflow-group");
    expect(parsed.group.guid).toBe(pkg.group.guid);
    expect(parsed.group.namespace).toBe(pkg.group.namespace);
    const validated = groupJsonSchema.parse(parsed.group); // load.ts schema 校验通过即契约成立
    expect(validated.currentVersion).toBe("1.0.0");
    expect(validated.versions).toHaveLength(1);
  });
});

describe("collectVersionFiles 与 buildGroupPackage 直接调用", () => {
  test("collectVersionFiles：目录缺失返回空数组（不抛错）", async () => {
    const missing = await collectVersionFiles(join(TEMP_BASE, "no-such-dir"));
    expect(missing).toEqual([]);
  });

  test("collectVersionFiles：现有目录返回 posix 相对路径 + utf8 内容", async () => {
    await writeGroup(TEMP_BASE, "web/scraping/playwright", makeGroup(), { "1.0.0": defaultVersionFiles("1.0.0") });
    const versionFiles = await collectVersionFiles(join(TEMP_BASE, "web", "scraping", "playwright", "v1.0.0"));

    expect(versionFiles.map((file) => file.path).sort()).toEqual([
      "agent.md",
      "mcp.json",
      "rules/01-navigation.md",
      "tools/read_file.json",
    ]); // posix "/"（Windows 反斜杠已转换）
    expect(versionFiles.find((file) => file.path === "agent.md")?.content).toBe("# Agent 1.0.0\n抓取网页。");
  });

  test("buildGroupPackage：files base64 编码 + group 原样透传", async () => {
    await writeGroup(TEMP_BASE, "web/scraping/playwright", makeGroup(), { "1.0.0": defaultVersionFiles("1.0.0") });
    const pkg = await exportGroupPackage(TEMP_BASE, "web/scraping/playwright", join(TEMP_BASE, "out", "a.hnflow-group"));

    const rebuilt = buildGroupPackage(pkg.group, [{ path: "v1.0.0/agent.md", content: "hello" }]);
    expect(rebuilt.format).toBe("hnflow-group");
    expect(rebuilt.formatVersion).toBe(1);
    expect(rebuilt.group).toBe(pkg.group); // 原样透传（同一引用）
    expect(rebuilt.files["v1.0.0/agent.md"]).toBe(Buffer.from("hello", "utf8").toString("base64"));
  });
});
