// CLI 测试：直接调用 main() 验证各子命令输出与退出码；
// 替换 console 捕获 stdout/stderr（引擎日志走 console.info，一并捕获）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Edge, Node, Port, Workflow } from "../src/model/types.js";
import type { RunState } from "../src/runstate/types.js";
import { main } from "../src/cli/index.js";
import { saveWorkflow } from "../src/storage/index.js";

const TEMP_DIR = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\cli-test";

/** 端口构造辅助（binding 可选）。 */
function makePort(id: string, name: string, direction: "in" | "out", binding?: string): Port {
  return binding === undefined
    ? { id, name, type: "any", direction }
    : { id, name, type: "any", direction, binding };
}

/** start → setVariable → end 的最小工作流（参照 examples/demo.ts 结构）。 */
function makeWorkflow(): Workflow {
  const startNode: Node = {
    id: "start",
    type: "start",
    name: "开始",
    params: {},
    inputs: [],
    outputs: [makePort("data", "data", "out", "workflow:start")],
  };
  const setNode: Node = {
    id: "set",
    type: "setVariable",
    name: "设置变量",
    params: { target: "workflow:greeting", value: "你好 ${global:name}" },
    inputs: [],
    outputs: [],
  };
  const endNode: Node = {
    id: "end",
    type: "end",
    name: "结束",
    params: {},
    inputs: [makePort("in", "data", "in", "workflow:endInput")],
    outputs: [],
  };
  const edges: readonly Edge[] = [
    { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "set", targetPortId: "in" },
    { id: "e2", sourceNodeId: "set", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
  ];
  return {
    id: "cli-wf",
    name: "CLI 测试工作流",
    version: "0.1.0",
    nodes: [startNode, setNode, endNode],
    edges,
    globalVariables: { name: "张三" },
  };
}

/** 构造完整 RunState（overrides 覆盖默认字段）。 */
function makeRunState(runId: string, workflow: Workflow): RunState {
  return {
    runId,
    workflowId: workflow.id,
    workflow,
    nodeStates: { start: "Success", set: "Success", end: "Success" },
    nodeOutputs: { start: { data: { name: "张三" } } },
    contextSnapshot: { global: {}, workflow: {}, node: {} },
    status: "success",
    updatedAt: 1700000000000,
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

beforeAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
  await mkdir(TEMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
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
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.info = originalInfo;
});

describe("workflows 子命令", () => {
  test("列出工作流文件：输出含文件名与 name", async () => {
    const wfPath = join(TEMP_DIR, "cli-wf.json");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "workflows", TEMP_DIR]);
    expect(code).toBe(0);
    expect(stdout).toContain("cli-wf.json");
    expect(stdout).toContain("CLI 测试工作流");
    expect(stdout).toContain("3/2"); // 节点/边
  });

  test("目录不存在：stderr 友好错误 + 非 0 退出码", async () => {
    const missingDir = join(TEMP_DIR, "no-such-dir");
    code = await runCli(["bun", "src/cli/index.ts", "workflows", missingDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("目录不存在");
  });
});

describe("runs 子命令", () => {
  test("store 文件不存在：提示无运行记录，退出码 0", async () => {
    const storePath = join(TEMP_DIR, "no-runs.json");
    code = await runCli(["bun", "src/cli/index.ts", "runs", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("无运行记录");
  });

  test("有运行记录：列出 runId/workflowId/status", async () => {
    const storePath = join(TEMP_DIR, "with-runs.json");
    const run = makeRunState("run-123", makeWorkflow());
    await writeFile(storePath, `${JSON.stringify({ runs: [run] }, null, 2)}\n`, "utf8");
    code = await runCli(["bun", "src/cli/index.ts", "runs", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("run-123");
    expect(stdout).toContain("cli-wf");
    expect(stdout).toContain("success");
  });
});

describe("run 子命令", () => {
  test("成功执行：输出 status: success", async () => {
    const wfPath = join(TEMP_DIR, "cli-wf.json");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("status: success");
    expect(stdout).toContain("cli-wf");
  });

  test("文件不存在：stderr 错误 + 非 0 退出码", async () => {
    const missingPath = join(TEMP_DIR, "no-such-workflow.json");
    code = await runCli(["bun", "src/cli/index.ts", "run", missingPath]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("不存在");
  });
});

describe("logs 子命令", () => {
  test("找到 run：打印 runId/status 与节点状态", async () => {
    const storePath = join(TEMP_DIR, "with-runs.json");
    const run = makeRunState("run-123", makeWorkflow());
    await writeFile(storePath, `${JSON.stringify({ runs: [run] }, null, 2)}\n`, "utf8");
    code = await runCli(["bun", "src/cli/index.ts", "logs", "run-123", storePath]);
    expect(code).toBe(0);
    expect(stdout).toContain("runId: run-123");
    expect(stdout).toContain("status: success");
    expect(stdout).toContain("Success");
  });

  test("未找到 run：stderr 错误 + 非 0 退出码", async () => {
    const storePath = join(TEMP_DIR, "no-runs.json");
    code = await runCli(["bun", "src/cli/index.ts", "logs", "missing-run", storePath]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("未找到运行记录");
  });
});

describe("命令分发", () => {
  test("未知命令：stderr 提示 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts", "bogus"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("未知命令");
  });

  test("无参数：打印用法 + 非 0 退出码", async () => {
    code = await runCli(["bun", "src/cli/index.ts"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("用法");
  });
});
