// 功能组 .hnflow-group 包导入测试（v0.9.1 T4）：解析校验 / 路径安全（防写盘逃逸）/ 冲突检测 / 内容完整性 / 端到端导出→导入→还原。
// 端到端调用 T3 export.ts 的 exportGroupPackage 产物，断言 scanGroups 还原与源一致。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exportGroupPackage } from "../src/groups/export.js";
import { assertSafePackagePath, parseGroupPackage, unpackGroupPackage } from "../src/groups/import.js";
import type { GroupPackage } from "../src/groups/import.js";
import { scanGroups } from "../src/groups/load.js";
import type { CapabilityGroup } from "../src/groups/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-import-test";

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

/** 源功能组元数据：多版本 + v1.0.0 deprecated 标记（T2 扩展字段）。 */
function makeGroup(): CapabilityGroup {
  return {
    guid: "g-import-e2e",
    namespace: "web/import/e2e",
    aliases: [],
    description: "导入端到端测试组",
    currentVersion: "2.0.0",
    versions: [
      {
        version: "1.0.0",
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: "初版",
        deprecated: true,
        content: {
          agent: "agent.md",
          tools: ["tools/old.json"],
          mcps: [],
          rules: [{ path: "rules/01-usage.md", order: 1 }],
        },
      },
      {
        version: "2.0.0",
        createdAt: "2026-08-02T00:00:00.000Z",
        changelog: "新版",
        content: {
          agent: "agent.md",
          tools: ["tools/new.json"],
          mcps: ["mcps/server.json"],
          rules: [{ path: "rules/01-usage.md", order: 1 }],
        },
      },
    ],
  };
}

/** 写源功能组目录（group.json + 各版本内容文件），返回组与文件清单。 */
async function writeSourceGroup(root: string): Promise<{ group: CapabilityGroup; files: Array<[string, string]> }> {
  const group = makeGroup();
  const files: Array<[string, string]> = [
    ["v1.0.0/agent.md", "# 旧版 agent\n"],
    ["v1.0.0/tools/old.json", `${JSON.stringify({ name: "old-tool" }, null, 2)}\n`],
    ["v1.0.0/rules/01-usage.md", "规则一（旧）\n"],
    ["v2.0.0/agent.md", "# 新版 agent\n"],
    ["v2.0.0/tools/new.json", `${JSON.stringify({ name: "new-tool" }, null, 2)}\n`],
    ["v2.0.0/mcps/server.json", `${JSON.stringify({ name: "mcp-server" }, null, 2)}\n`],
    ["v2.0.0/rules/01-usage.md", "规则一（新）\n"],
    ["v2.0.0/rules/02-extra.md", "多余文件（content 未声明，应宽容还原）\n"],
  ];
  const groupDir = join(root, ...group.namespace.split("/"));
  for (const [rel, content] of files) {
    const absolute = join(groupDir, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await writeFile(join(groupDir, "group.json"), `${JSON.stringify(group, null, 2)}\n`, "utf8");
  return { group, files };
}

/** 构造包对象（测试用：files 值已 base64 编码）。 */
function makePackage(group: CapabilityGroup, files: Record<string, string>): GroupPackage {
  return {
    format: "hnflow-group",
    formatVersion: 1,
    exportedAt: "2026-08-07T00:00:00.000Z",
    group,
    files,
  };
}

function base64(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

/** 构造内容完整的包：源组各版本文件全部进 files；extraFiles 追加（如多余文件）。 */
function makeFullPackage(extraFiles: Record<string, string> = {}): GroupPackage {
  const group = makeGroup();
  return makePackage(group, {
    "v1.0.0/agent.md": base64("# 旧版 agent\n"),
    "v1.0.0/tools/old.json": base64("{\"name\":\"old-tool\"}\n"),
    "v1.0.0/rules/01-usage.md": base64("规则一（旧）\n"),
    "v2.0.0/agent.md": base64("# 新版 agent\n"),
    "v2.0.0/tools/new.json": base64("{\"name\":\"new-tool\"}\n"),
    "v2.0.0/mcps/server.json": base64("{\"name\":\"mcp-server\"}\n"),
    "v2.0.0/rules/01-usage.md": base64("规则一（新）\n"),
    ...extraFiles,
  });
}

describe("assertSafePackagePath", () => {
  test("合法路径：v<semver>/ 前缀 + 子目录", () => {
    expect(assertSafePackagePath("v1.0.0/agent.md")).toBe("v1.0.0/agent.md");
    expect(assertSafePackagePath("v2.3.4/tools/x.json")).toBe("v2.3.4/tools/x.json");
  });

  test("路径穿越：../ 段拒绝", () => {
    expect(() => assertSafePackagePath("v1.0.0/../evil")).toThrow(/\.\./);
    expect(() => assertSafePackagePath("v1.0.0/../../etc/passwd")).toThrow(/\.\./);
  });

  test("绝对路径拒绝", () => {
    expect(() => assertSafePackagePath("/etc/passwd")).toThrow(/绝对路径/);
    expect(() => assertSafePackagePath("v1.0.0/../etc/passwd")).toThrow(/\.\./);
  });

  test("反斜杠拒绝", () => {
    expect(() => assertSafePackagePath("v1.0.0\\..\\evil")).toThrow(/反斜杠/);
    expect(() => assertSafePackagePath("v1.0.0\\agent.md")).toThrow(/反斜杠/);
  });

  test("非 v<semver>/ 前缀拒绝", () => {
    expect(() => assertSafePackagePath("agent.md")).toThrow(/前缀/);
    expect(() => assertSafePackagePath("v1.0/agent.md")).toThrow(/前缀/);
    expect(() => assertSafePackagePath("vx.y.z/agent.md")).toThrow(/前缀/);
    expect(() => assertSafePackagePath("")).toThrow(/不能为空/);
  });
});

describe("parseGroupPackage", () => {
  test("合法包：解析成功且元数据/文件齐全", () => {
    const pkg = makeFullPackage();
    const parsed = parseGroupPackage(JSON.stringify(pkg));
    expect(parsed.format).toBe("hnflow-group");
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.group.guid).toBe("g-import-e2e");
    expect(parsed.group.versions[0]?.deprecated).toBe(true);
    expect(Object.keys(parsed.files)).toHaveLength(7);
  });

  test("非法 JSON 抛中文错误", () => {
    expect(() => parseGroupPackage("{ not json")).toThrow(/不是合法 JSON/);
  });

  test("format 非法抛错误", () => {
    const pkg = makeFullPackage();
    const raw = JSON.stringify({ ...pkg, format: "other" });
    expect(() => parseGroupPackage(raw)).toThrow(/格式标识非法/);
  });

  test("formatVersion 不符抛错误", () => {
    const pkg = makeFullPackage();
    const raw = JSON.stringify({ ...pkg, formatVersion: 2 });
    expect(() => parseGroupPackage(raw)).toThrow(/格式版本不匹配/);
  });

  test("group 非对象抛错误", () => {
    const pkg = makeFullPackage();
    const raw = JSON.stringify({ ...pkg, group: "not-object" });
    expect(() => parseGroupPackage(raw)).toThrow(/group 字段必须为对象/);
  });

  test("files 非对象抛错误", () => {
    const pkg = makeFullPackage();
    const raw = JSON.stringify({ ...pkg, files: [] });
    expect(() => parseGroupPackage(raw)).toThrow(/files 字段必须为对象/);
  });

  test("files 值非 base64 字符串抛错误", () => {
    const pkg = makeFullPackage();
    const raw = JSON.stringify({ ...pkg, files: { "v1.0.0/agent.md": 123 } });
    expect(() => parseGroupPackage(raw)).toThrow(/必须为 base64 字符串/);
  });

  test("files 路径非法抛错误（../evil / 绝对路径 / 反斜杠）", () => {
    const pkg = makeFullPackage();
    expect(() => parseGroupPackage(JSON.stringify({ ...pkg, files: { "../evil": base64("x") } }))).toThrow(/\.\./);
    expect(() => parseGroupPackage(JSON.stringify({ ...pkg, files: { "C:\\evil": base64("x") } }))).toThrow(/反斜杠/);
    expect(() => parseGroupPackage(JSON.stringify({ ...pkg, files: { "/etc/passwd": base64("x") } }))).toThrow(/绝对路径/);
  });
});

describe("unpackGroupPackage 冲突检测", () => {
  test("同 GUID 再导入报错", async () => {
    const rootB = join(TEMP_BASE, "dst");
    await unpackGroupPackage(rootB, makeFullPackage());
    await expect(unpackGroupPackage(rootB, makeFullPackage())).rejects.toThrow(/GUID 冲突/);
  });

  test("同 namespace 再导入报错", async () => {
    const rootB = join(TEMP_BASE, "dst");
    await mkdir(join(rootB, "web", "import", "e2e"), { recursive: true });
    const other = makeGroup();
    const otherGroup: CapabilityGroup = { ...other, guid: "g-other-guid" };
    await writeFile(
      join(rootB, "web", "import", "e2e", "group.json"),
      `${JSON.stringify(otherGroup, null, 2)}\n`,
      "utf8",
    );
    await expect(unpackGroupPackage(rootB, makeFullPackage())).rejects.toThrow(/namespace "web\/import\/e2e" 已被占用/);
  });

  test("目标目录已占用（无 group.json）报错", async () => {
    const rootB = join(TEMP_BASE, "dst");
    await mkdir(join(rootB, "web", "import", "e2e"), { recursive: true });
    await expect(unpackGroupPackage(rootB, makeFullPackage())).rejects.toThrow(/目录 .* 已被占用/);
  });
});

describe("unpackGroupPackage 内容完整性", () => {
  test("content 声明的文件缺失报错", async () => {
    const group = makeGroup();
    const pkg = makePackage(group, {
      "v1.0.0/agent.md": base64("# 旧版 agent\n"),
      "v1.0.0/tools/old.json": base64("{}"),
      "v1.0.0/rules/01-usage.md": base64("规则"),
      "v2.0.0/agent.md": base64("# 新版 agent\n"),
      // 缺 v2.0.0/tools/new.json 与 mcps/server.json
      "v2.0.0/rules/01-usage.md": base64("规则"),
    });
    await expect(unpackGroupPackage(join(TEMP_BASE, "dst"), pkg)).rejects.toThrow(
      /包文件缺失：content 声明的 "v2\.0\.0\/tools\/new\.json"/,
    );
  });

  test("多余文件宽容还原", async () => {
    const rootB = join(TEMP_BASE, "dst");
    const pkg = makeFullPackage({ "v2.0.0/rules/02-extra.md": base64("多余文件\n") });
    await unpackGroupPackage(rootB, pkg);
    const extra = await readFile(join(rootB, "web", "import", "e2e", "v2.0.0", "rules", "02-extra.md"), "utf8");
    expect(extra).toBe("多余文件\n");
  });
});

describe("端到端：导出 → 导入 → scanGroups 还原", () => {
  test("guid/namespace/currentVersion/versions 与内容文件全部一致", async () => {
    const rootA = join(TEMP_BASE, "src");
    const rootB = join(TEMP_BASE, "dst");
    const { group: source, files } = await writeSourceGroup(rootA);

    // T3 导出：原子写包文件（返回对象在第二用例验证直通路径）
    await exportGroupPackage(rootA, source.namespace, join(TEMP_BASE, "pkg.hnflow-group"));
    // 读回包文件再解析（验证 T3 原子写产物可被 parseGroupPackage 接受）
    const raw = await readFile(join(TEMP_BASE, "pkg.hnflow-group"), "utf8");
    const parsed = parseGroupPackage(raw);
    // T4 导入到临时根 B
    const restored = await unpackGroupPackage(rootB, parsed);

    // 元数据还原：guid / namespace / currentVersion / versions 数 / deprecated 标记
    expect(restored.guid).toBe(source.guid);
    expect(restored.namespace).toBe(source.namespace);
    expect(restored.currentVersion).toBe(source.currentVersion);
    expect(restored.versions).toHaveLength(source.versions.length);
    expect(restored.versions[0]?.deprecated).toBe(true);
    expect(restored.versions[1]?.deprecated).toBeUndefined();
    expect(restored.versions[1]?.content.tools).toEqual(source.versions[1]?.content.tools);
    expect(restored.versions[1]?.content.mcps).toEqual(source.versions[1]?.content.mcps);
    expect(restored.versions[1]?.content.rules).toEqual(source.versions[1]?.content.rules);

    // scanGroups 还原一致（验收 2 闭环终点）
    const scanned = await scanGroups(rootB);
    expect(scanned).toHaveLength(1);
    const imported = scanned[0];
    if (imported === undefined) throw new Error("scanGroups 返回空");
    expect(imported.guid).toBe(source.guid);
    expect(imported.namespace).toBe(source.namespace);
    expect(imported.currentVersion).toBe(source.currentVersion);
    expect(imported.versions).toHaveLength(source.versions.length);
    expect(imported.versions[0]?.deprecated).toBe(true);

    // 内容文件解码一致（agent.md / tools / rules / 多余文件）
    for (const [rel, content] of files) {
      const importedContent = await readFile(join(rootB, "web", "import", "e2e", rel), "utf8");
      expect(importedContent).toBe(content);
    }
  });

  test("包对象直通 unpackGroupPackage（不经文件）同样还原", async () => {
    const rootA = join(TEMP_BASE, "src");
    const rootB = join(TEMP_BASE, "dst");
    const { group: source } = await writeSourceGroup(rootA);
    const pkg = await exportGroupPackage(rootA, source.namespace, join(TEMP_BASE, "pkg2.hnflow-group"));
    const restored = await unpackGroupPackage(rootB, pkg);
    expect(restored.guid).toBe(source.guid);
  });
});
