// template 子命令测试（T6）：create/release/list/history 四个子命令的 CLI 行为。
// 直接调 cmdTemplate 验证；临时目录用 opencode 专用 temp，Windows 清理惯例（rmRetry + Bun.gc(true)）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cmdTemplate } from "../src/cli/template.js";
import type { Edge, Node, Port, Workflow } from "../src/model/types.js";
import { saveWorkflow } from "../src/storage/index.js";

const TEMP_DIR = `C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\hnflow-tests-${randomUUID().slice(0, 8)}`;

let stdout = "";
let stderr = "";
let code = -1;

/** 重置捕获缓冲并执行 cmdTemplate；返回退出码。 */
async function runCli(args: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return cmdTemplate(args);
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 端口构造辅助（binding 可选）。 */
function makePort(id: string, name: string, direction: "in" | "out", binding?: string): Port {
  return binding === undefined
    ? { id, name, type: "any", direction }
    : { id, name, type: "any", direction, binding };
}

// ── 构造工作流：a →(stdout) b →(result) c；打包选中 [a, b, c] ──
// 无边界入边/出边，自动补 __end 连接无出边的 c；c 有 stdout 输出故 __end 有入边。

const aNode: Node = {
  id: "a",
  type: "command",
  name: "命令 A",
  params: { command: "node", args: ["-e", "console.log('a')"] },
  inputs: [makePort("in", "in", "in")],
  outputs: [makePort("stdout", "stdout", "out")],
};

const bNode: Node = {
  id: "b",
  type: "setVariable",
  name: "写入变量",
  params: { target: "workflow:y", value: "${workflow:x}+5" },
  inputs: [makePort("text", "text", "in")],
  outputs: [makePort("result", "result", "out")],
};

const cNode: Node = {
  id: "c",
  type: "command",
  name: "命令 C",
  params: { command: "node", args: ["-e", "console.log('c')"] },
  inputs: [makePort("in", "in", "in")],
  outputs: [makePort("stdout", "stdout", "out")],
};

const edges: readonly Edge[] = [
  { id: "e1", sourceNodeId: "a", sourcePortId: "stdout", targetNodeId: "b", targetPortId: "text" },
  { id: "e2", sourceNodeId: "b", sourcePortId: "result", targetNodeId: "c", targetPortId: "in" },
];

function makeWorkflow(): Workflow {
  return {
    id: "tpl-cli-wf",
    name: "模板 CLI 测试工作流",
    version: "0.1.0",
    nodes: [aNode, bNode, cNode],
    edges,
  };
}

/** 写工作流文件并 create demo 模板（成功断言退出 0）。 */
async function createDemo(): Promise<void> {
  const wfPath = join(TEMP_DIR, "wf.json");
  await saveWorkflow(wfPath, makeWorkflow());
  code = await runCli(["create", "demo", wfPath, "a,b,c", "--dir", TEMP_DIR]);
  expect(code).toBe(0);
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

describe("template create 子命令", () => {
  test("打包节点创建模板：退出 0 + template.json + v0.1.0/workflow.json", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["create", "demo", wfPath, "a,b,c", "--dir", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("已创建模板 demo v0.1.0");
    expect(await fileExists(join(TEMP_DIR, "demo", "template.json"))).toBe(true);
    expect(await fileExists(join(TEMP_DIR, "demo", "v0.1.0", "workflow.json"))).toBe(true);
  });

  test("缺参：非 0 退出 + 用法提示", async () => {
    code = await runCli(["create", "demo"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少");
    expect(stderr).toContain("用法");
  });

  test("目录已存在：非 0 退出", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow());
    await runCli(["create", "demo", wfPath, "a,b,c", "--dir", TEMP_DIR]);
    code = await runCli(["create", "demo", wfPath, "a,b,c", "--dir", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("已存在");
  });
});

describe("template release 子命令", () => {
  test("发布新版本：退出 0 + currentVersion 更新", async () => {
    await createDemo();
    code = await runCli(["release", "demo", "-v", "1.0.0", "--dir", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("已发布 demo v1.0.0");
    const parsed = JSON.parse(await readFile(join(TEMP_DIR, "demo", "template.json"), "utf8")) as {
      currentVersion?: unknown;
    };
    expect(parsed.currentVersion).toBe("1.0.0");
  });

  test("版本不递增：非 0 退出", async () => {
    await createDemo();
    code = await runCli(["release", "demo", "-v", "0.1.0", "--dir", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("版本必须递增");
  });
});

describe("template list 子命令", () => {
  test("空目录：退出 0 且提示没有模板", async () => {
    code = await runCli(["list", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("没有模板");
  });

  test("有模板：退出 0 且输出含模板名", async () => {
    await createDemo();
    code = await runCli(["list", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("demo");
  });

  test("目录不存在：非 0 退出", async () => {
    code = await runCli(["list", join(TEMP_DIR, "no-such")]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("模板根目录不存在");
  });
});

describe("template history 子命令", () => {
  test("存在：退出 0 且含版本", async () => {
    await createDemo();
    code = await runCli(["history", "demo", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("0.1.0");
  });

  test("不存在：非 0 退出", async () => {
    code = await runCli(["history", "no-such", TEMP_DIR]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("模板不存在");
  });
});
