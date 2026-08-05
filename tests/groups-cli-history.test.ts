// group history 子命令测试（v0.3.2 T6）：列出版本历史表格，语义版本降序（当前版本在最上）。
// 直接调 cmdGroup(["history", namespace, dir]) 验证；临时目录用 opencode 专用 temp，Windows 清理惯例（rmRetry + Bun.gc(true)）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cmdGroup } from "../src/cli/groups.js";
import type { CapabilityGroup } from "../src/groups/types.js";

const TEMP_DIR = `C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\hnflow-tests-${randomUUID().slice(0, 8)}`;

let stdout = "";
let stderr = "";
let code = -1;

/** 重置捕获缓冲并执行 cmdGroup；返回退出码。 */
async function runCli(args: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return cmdGroup(args);
}

const originalLog = console.log;
const originalError = console.error;
const originalInfo = console.info;
const originalWarn = console.warn;

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

/** 构造含指定版本的 group.json：versions 顺序按传入（测试故意乱序以验证 history 重排）。history 只读 versions 元数据。 */
async function writeGroup(
  dir: string,
  namespace: string,
  versions: Array<{ version: string; changelog?: string }>,
  currentVersion?: string,
): Promise<void> {
  const groupDir = join(dir, ...namespace.split("/"));
  await mkdir(groupDir, { recursive: true });
  const group: CapabilityGroup = {
    guid: randomUUID(),
    namespace,
    aliases: [],
    description: "",
    versions: versions.map((version, index) => ({
      version: version.version,
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
      changelog: version.changelog ?? `更新 ${version.version}`,
      content: { tools: [], mcps: [], rules: [] },
    })),
    currentVersion: currentVersion ?? versions.at(-1)?.version ?? "0.1.0",
  };
  await writeFile(join(groupDir, "group.json"), `${JSON.stringify(group, null, 2)}\n`, "utf8");
}

beforeAll(async () => {
  await rmRetry(TEMP_DIR);
  await mkdir(TEMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rmRetry(TEMP_DIR);
  Bun.gc(true);
}, 30000);

beforeEach(async () => {
  await rmRetry(TEMP_DIR);
  await mkdir(TEMP_DIR, { recursive: true });
  stdout = "";
  stderr = "";
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  console.info = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.warn = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.info = originalInfo;
  console.warn = originalWarn;
});

describe("group history 子命令", () => {
  test("多版本：输出语义版本降序表格（1.10.0 → 1.9.0 → 1.2.0 → 1.0.0 → 0.1.0）", async () => {
    // versions 故意乱序传入，验证 history 按语义版本重排；含 1.10.0/1.9.0 以区分语义排序与字符串排序（"1.10.0" < "1.9.0" 字符串比较错误）。
    await writeGroup(
      TEMP_DIR,
      "demo/core",
      [
        { version: "0.1.0" },
        { version: "1.10.0" },
        { version: "1.0.0" },
        { version: "1.2.0" },
        { version: "1.9.0" },
      ],
      "1.10.0",
    );
    code = await runCli(["history", "demo/core", TEMP_DIR]);
    expect(code).toBe(0);
    const descending = ["1.10.0", "1.9.0", "1.2.0", "1.0.0", "0.1.0"];
    let lastIndex = -1;
    for (const version of descending) {
      const index = stdout.indexOf(version);
      expect(index).toBeGreaterThan(-1); // 每版都出现
      expect(index).toBeGreaterThan(lastIndex); // 顺序严格降序
      lastIndex = index;
    }
  });

  test("缺 namespace：非 0 退出 + 提示", async () => {
    code = await runCli(["history"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少 namespace");
  });

  test("组不存在（目录缺失）：非 0 退出 + 用法", async () => {
    code = await runCli(["history", "no/such", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("功能组不存在");
    expect(stderr).toContain("用法");
  });

  test("只有一版：正常输出表格", async () => {
    await writeGroup(TEMP_DIR, "solo", [{ version: "0.1.0", changelog: "初始版本" }]);
    code = await runCli(["history", "solo", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("0.1.0");
    expect(stdout).toContain("初始版本");
  });
});
