// run 子命令 --groups 选项测试（v0.3.1 T7）：
// --groups <dir> 透传 ExecutionEngineOptions.groupsRootDir；缺值/非目录/不存在路径报错清晰；无 --groups 行为不变（回归）。
// 夹具照 tests/cli.test.ts（saveWorkflow + main 直接调用）；临时目录用 opencode 专用 temp，Windows 清理惯例。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node, Workflow } from "../src/model/types.js";
import { main } from "../src/cli/index.js";
import { saveWorkflow } from "../src/storage/index.js";

const TEMP_DIR = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-cli-run-test";

/** 最小 fake 工作流：仅 log 节点（无功能组依赖也能跑，含节点日志输出）。 */
function makeLogWorkflow(): Workflow {
  const logNode: Node = {
    id: "log",
    type: "log",
    name: "日志",
    params: { level: "info", message: "hello groups" },
    inputs: [],
    outputs: [],
  };
  return {
    id: "groups-cli-wf",
    name: "功能组 CLI 测试工作流",
    version: "0.1.0",
    nodes: [logNode],
    edges: [],
    globalVariables: {},
  };
}

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

beforeAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
  await mkdir(TEMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
}, 30000);

beforeEach(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
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

describe("run --groups 子命令", () => {
  test("--groups 传目录：执行成功（无 capabilityGroups 节点，groups 仅装配不加载）", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    const groupsDir = join(TEMP_DIR, "groups");
    await saveWorkflow(wfPath, makeLogWorkflow());
    await mkdir(groupsDir, { recursive: true });
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--groups", groupsDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("status: success");
    expect(stdout).toContain("groups-cli-wf");
  });

  test("无 --groups：行为不变（回归）", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    await saveWorkflow(wfPath, makeLogWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("status: success");
    expect(stdout).toContain("groups-cli-wf");
  });

  test("--groups 缺值：stderr 提示缺少值 + 非 0 退出码", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    await saveWorkflow(wfPath, makeLogWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--groups"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少值");
  });

  test("--groups 指向文件（非目录）：fail 含 不是目录 + 非 0 退出码", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    const filePath = join(TEMP_DIR, "not-dir.txt");
    await saveWorkflow(wfPath, makeLogWorkflow());
    await writeFile(filePath, "content", "utf8");
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--groups", filePath]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("不是目录");
    expect(stderr).toContain(filePath);
  });

  test("--groups 指向不存在路径：fail 错误含路径 + 非 0 退出码", async () => {
    const wfPath = join(TEMP_DIR, "wf.json");
    const missingDir = join(TEMP_DIR, "no-such-groups");
    await saveWorkflow(wfPath, makeLogWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--groups", missingDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain(missingDir);
  });
});
