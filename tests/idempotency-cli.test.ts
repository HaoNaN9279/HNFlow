// CLI 幂等接入测试（v0.2.5 T5）：main 直接调用验证 run --idempotency-key/--store；
// SQLite store 落盘含幂等键、同键二次运行冲突非零退出、无键回归现状（不持久化）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Edge, Node, Port, Workflow } from "../src/model/types.js";
import { main } from "../src/cli/index.js";
import { saveWorkflow } from "../src/storage/index.js";
import { SqliteRunStateStore } from "../src/db/index.js";

const TEMP_DIR = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\idempotency-cli-test";

/** 端口构造辅助（binding 可选）。 */
function makePort(id: string, name: string, direction: "in" | "out", binding?: string): Port {
  return binding === undefined
    ? { id, name, type: "any", direction }
    : { id, name, type: "any", direction, binding };
}

/** start → setVariable → end 的最小工作流（同 cli.test.ts 结构，纯幂等节点）。 */
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
    id: "cli-idem-wf",
    name: "CLI 幂等测试工作流",
    version: "0.1.0",
    nodes: [startNode, setNode, endNode],
    edges,
    globalVariables: { name: "张三" },
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
  // Windows 上 sqlite 句柄释放有瞬态延迟，重试删除避免 EBUSY。
  await rmRetry(TEMP_DIR);
}, 30000);

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true);
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

describe("run --idempotency-key", () => {
  test("带 key 首次 run：退出码 0，RunState 落盘含 idempotencyKey", async () => {
    const wfPath = join(TEMP_DIR, "cli-idem-wf.json");
    const dbPath = join(TEMP_DIR, "runs-a.db");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--idempotency-key", "req-1", "--store", dbPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("status: success");
    expect(stdout).toContain("runId:");
    const store = new SqliteRunStateStore(dbPath);
    try {
      const runs = await store.list();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.idempotencyKey).toBe("req-1");
      expect(runs[0]?.status).toBe("success");
    } finally {
      await store.close();
    }
  });

  test("同 key 第二次 run：非零退出，stderr 含冲突错误", async () => {
    const wfPath = join(TEMP_DIR, "cli-idem-wf.json");
    const dbPath = join(TEMP_DIR, "runs-b.db");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--idempotency-key", "req-2", "--store", dbPath]);
    expect(code).toBe(0);
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--idempotency-key", "req-2", "--store", dbPath]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("idempotency key conflict");
    expect(stderr).toContain("req-2");
    const store = new SqliteRunStateStore(dbPath);
    try {
      expect(await store.list()).toHaveLength(1); // 冲突不执行，记录不重复
    } finally {
      await store.close();
    }
  });

  test("不同 key：均可运行，store 累计两条", async () => {
    const wfPath = join(TEMP_DIR, "cli-idem-wf.json");
    const dbPath = join(TEMP_DIR, "runs-c.db");
    await saveWorkflow(wfPath, makeWorkflow());
    for (const key of ["k-a", "k-b"]) {
      code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--idempotency-key", key, "--store", dbPath]);
      expect(code).toBe(0);
    }
    const store = new SqliteRunStateStore(dbPath);
    try {
      expect(await store.list()).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  test("无 key run：退出码 0（现状回归，不持久化）", async () => {
    const wfPath = join(TEMP_DIR, "cli-idem-wf.json");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("status: success");
  });

  test("非法参数：缺选项值 / 未知选项 / 多余参数均非零退出", async () => {
    const wfPath = join(TEMP_DIR, "cli-idem-wf.json");
    await saveWorkflow(wfPath, makeWorkflow());
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--idempotency-key"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少值");
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "--bogus"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("未知选项");
    code = await runCli(["bun", "src/cli/index.ts", "run", wfPath, "extra.json"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("多余参数");
  });
});
