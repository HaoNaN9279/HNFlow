// RunState 断点存储测试：原子写读回、重启恢复、损坏检测、findPending、upsert 语义。
import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { RunStateCorruptedError, RunStateStore } from "../src/runstate/RunStateStore.js";
import type { RunState } from "../src/runstate/types.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string): Node {
  const def = registry.get(type);
  return { id, type, name: id, params: {}, inputs: def.inputs, outputs: def.outputs };
}

/** start → end 的最小合法工作流。 */
function makeWorkflow(): Workflow {
  return {
    id: "run-wf",
    name: "run-workflow",
    version: "0.1.0",
    nodes: [makeNode("start", "start"), makeNode("end", "end")],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 构造 RunState，overrides 覆盖默认字段。 */
function makeRunState(runId: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runId,
    workflowId: "run-wf",
    workflow: makeWorkflow(),
    nodeStates: {},
    nodeOutputs: {},
    contextSnapshot: { global: {}, workflow: {}, node: {} },
    status: "running",
    updatedAt: 1000,
    ...overrides,
  };
}

// 每个测试独立 store 文件，afterAll 统一清理。
const runStorePaths: string[] = [];
const humanStorePaths: string[] = [];
let fileCounter = 0;
function nextRunStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-runstate-${Date.now()}-${fileCounter++}.json`);
  runStorePaths.push(path);
  return path;
}
function nextHumanStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-runstate-human-${Date.now()}-${fileCounter++}.json`);
  humanStorePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(runStorePaths.map((path) => rm(path, { force: true })));
  await Promise.all(humanStorePaths.map((path) => rm(path, { force: true })));
});

describe("RunStateStore 原子写读回", () => {
  test("create 后文件内容可 JSON.parse 且字段一致", async () => {
    const filePath = nextRunStorePath();
    const store = new RunStateStore({ filePath });
    const run = makeRunState("run-atomic", { status: "success", error: "boom" });
    await store.create(run);

    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("runs" in parsed)) {
      throw new Error("expected { runs: [...] } payload");
    }
    const runs = parsed.runs;
    if (!Array.isArray(runs)) {
      throw new Error("expected runs array");
    }
    const stored = runs[0];
    if (typeof stored !== "object" || stored === null) {
      throw new Error("expected run object");
    }
    expect(stored).toHaveProperty("runId", run.runId);
    expect(stored).toHaveProperty("workflowId", run.workflowId);
    expect(stored).toHaveProperty("status", run.status);
    expect(stored).toHaveProperty("error", run.error);
    expect(stored).toHaveProperty("updatedAt", run.updatedAt);
    expect(stored).toHaveProperty("workflow.id", run.workflow.id);
  });
});

describe("RunStateStore 重启恢复", () => {
  test("store1.create 后新 RunStateStore（同 filePath）list 读到同一 run", async () => {
    const filePath = nextRunStorePath();
    const store1 = new RunStateStore({ filePath });
    const run = makeRunState("run-restart", { status: "waiting", pendingNodeId: "start" });
    await store1.create(run);

    const store2 = new RunStateStore({ filePath });
    const all = await store2.list();
    expect(all).toHaveLength(1);
    const restored = all[0];
    if (restored === undefined) {
      throw new Error("expected one run");
    }
    expect(restored.runId).toBe("run-restart");
    expect(restored.workflowId).toBe(run.workflowId);
    expect(restored.status).toBe("waiting");
    expect(restored.pendingNodeId).toBe("start");
    expect(restored.workflow.id).toBe("run-wf");
  });

  test("listByWorkflow 按 workflowId 过滤", async () => {
    const filePath = nextRunStorePath();
    const store = new RunStateStore({ filePath });
    await store.create(makeRunState("run-w1", { workflowId: "wf-a" }));
    await store.create(makeRunState("run-w2", { workflowId: "wf-b" }));

    const byA = await store.listByWorkflow("wf-a");
    expect(byA).toHaveLength(1);
    expect(byA[0]?.runId).toBe("run-w1");
  });
});

describe("RunStateStore 损坏文件", () => {
  test("非法 JSON → load 抛 RunStateCorruptedError", async () => {
    const filePath = nextRunStorePath();
    await writeFile(filePath, "{ not valid json", "utf8");
    const store = new RunStateStore({ filePath });
    await expect(store.load()).rejects.toThrow(RunStateCorruptedError);
  });

  test("结构不符（缺 runs 字段）→ load 抛 RunStateCorruptedError", async () => {
    const filePath = nextRunStorePath();
    await writeFile(filePath, JSON.stringify({ tasks: [] }), "utf8");
    const store = new RunStateStore({ filePath });
    await expect(store.load()).rejects.toThrow(RunStateCorruptedError);
  });
});

describe("HumanTaskStore.findPending 查重", () => {
  test("pending 命中；completed 后未命中", async () => {
    const store = new HumanTaskStore({ filePath: nextHumanStorePath() });
    const created = await store.create({
      workflowId: "wf-fp",
      nodeId: "human",
      nodeName: "审批",
      title: "findPending",
    });

    const found = await store.findPending("wf-fp", "human");
    expect(found?.id).toBe(created.id);
    expect(await store.findPending("wf-other", "human")).toBeUndefined();

    await store.complete(created.id);
    expect(await store.findPending("wf-fp", "human")).toBeUndefined();
  });
});

describe("RunStateStore upsert 语义", () => {
  test("同 runId update 两次 → 单条记录且为最新", async () => {
    const filePath = nextRunStorePath();
    const store = new RunStateStore({ filePath });
    await store.create(makeRunState("run-up", { status: "running", updatedAt: 1000 }));
    await store.update(makeRunState("run-up", { status: "success", updatedAt: 2000 }));

    const all = await store.list();
    expect(all).toHaveLength(1);
    const latest = all[0];
    if (latest === undefined) {
      throw new Error("expected one run");
    }
    expect(latest.status).toBe("success");
    expect(latest.updatedAt).toBe(2000);
  });
});
