// groups/group 子命令 CLI 测试（v0.3.0 T7）：直接调 main() 验证 groups list / group init / group release。
// 替换 console 捕获 stdout/stderr/warn；临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { openGroupIndex } from "../src/groups/index-store.js";
import { main } from "../src/cli/index.js";

const TEMP_DIR = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-cli-test";

let stdout = "";
let stderr = "";
let code = -1;

/** 重置捕获缓冲并执行 main；返回退出码。 */
async function runCli(argv: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return main(argv);
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

beforeAll(async () => {
  await rmRetry(TEMP_DIR);
  await mkdir(TEMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rmRetry(TEMP_DIR);
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

describe("groups list 子命令", () => {
  test("空目录：退出码 0 + 提示输出", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "groups", "list", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("没有功能组");
  });

  test("根目录不存在：fail 提示 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "groups", "list", join(TEMP_DIR, "no-such")]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("不存在");
  });
});

describe("group init 子命令", () => {
  test("创建成功：退出码 0 + 输出 GUID/namespace/初始版本", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/GUID: [0-9a-f]{8}-[0-9a-f-]{27}/);
    expect(stdout).toContain("demo/core");
    expect(stdout).toContain("v0.1.0");
  });

  test("初始化后 groups list 显示该组", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "web/scraping", TEMP_DIR]);
    code = await runCli(["bun", "src/cli/index.ts", "groups", "list", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("web/scraping");
    expect(stdout).toContain("0.1.0");
  });

  test("非法 namespace：非 0 退出 + 错误消息", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "group", "init", "../evil", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("非法");
  });

  test("namespace 已存在：非 0 退出", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    code = await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("已存在");
  });
});

describe("group release 子命令", () => {
  test("发布成功：退出码 0 + 索引库生成且可查 + list currentVersion 更新", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    code = await runCli(["bun", "src/cli/index.ts", "group", "release", "demo/core", "-v", "1.0.0", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("v1.0.0");

    // 索引库存在且可查（组行 + 新版本资源行，agent.md 至少 1 条）。
    const indexPath = join(TEMP_DIR, ".hnflow-groups.db");
    const index = await openGroupIndex(indexPath);
    try {
      const entry = (await index.listGroups())[0];
      expect(entry?.namespace).toBe("demo/core");
      expect(entry?.currentVersion).toBe("1.0.0");
      if (entry !== undefined) {
        const resources = await index.listResources(entry.guid, "1.0.0");
        expect(resources.length).toBeGreaterThan(0);
      }
    } finally {
      await index.close();
    }

    code = await runCli(["bun", "src/cli/index.ts", "groups", "list", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("1.0.0");
  });

  test("缺 -v：非 0 退出 + usage 输出", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    code = await runCli(["bun", "src/cli/index.ts", "group", "release", "demo/core", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("用法");
  });

  test("版本不递增：非 0 退出", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    code = await runCli(["bun", "src/cli/index.ts", "group", "release", "demo/core", "-v", "0.1.0", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("递增");
  });

  test("同版本重发：非 0 退出（版本目录不可变）", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    await runCli(["bun", "src/cli/index.ts", "group", "release", "demo/core", "-v", "1.0.0", TEMP_DIR]);
    code = await runCli(["bun", "src/cli/index.ts", "group", "release", "demo/core", "-v", "1.0.0", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("递增");
  });

  test("索引同步失败不阻断 release：退出码 0 + 警告", async () => {
    await runCli(["bun", "src/cli/index.ts", "group", "init", "demo/core", TEMP_DIR]);
    // 用目录占住索引库路径，使 openGroupIndex 打开失败 → 触发警告路径。
    await mkdir(join(TEMP_DIR, ".hnflow-groups.db"), { recursive: true });
    code = await runCli(["bun", "src/cli/index.ts", "group", "release", "demo/core", "-v", "1.0.0", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("v1.0.0");
    expect(stderr).toContain("索引同步失败");
  });
});
