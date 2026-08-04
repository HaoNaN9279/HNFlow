// 断点机制核心 e2e（v0.2.4 T2）：命中暂停、快照落盘、debugResume 恢复、容器/末尾节点断点、挂起不干扰。
// 独立 NodeRegistry（内置 + 自定义 countTick 计数节点，副作用验证不重跑）；SQLite 临时库（照 loop-recovery 模式）。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { debugResume } from "../src/execution/resume.js";
import { DebugController } from "../src/execution/DebugController.js";
import { openDatabase, SqliteHumanTaskStore, SqliteRunStateStore, type SqliteDatabase } from "../src/db/index.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\debug-breakpoint-test";
let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}
const sharedDbs: SqliteDatabase[] = [];
beforeAll(async () => { await mkdir(TEMP_BASE, { recursive: true }); });
afterAll(async () => { for (const db of sharedDbs) db.close(); await rmRetry(TEMP_BASE); }, 30000);

async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
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

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
}
function countNode(id: string): Node {
  return { id, type: "countTick", name: id, params: {}, inputs: [], outputs: [{ id: "out", name: "out", type: "any", direction: "out" }] };
}
const countState = { a: 0, b: 0 };
const countTickDef: INodeDefinition = {
  type: "countTick",
  name: "countTick",
  inputs: [],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    if (ctx.node.id === "tickA") return { out: ++countState.a };
    return { out: ++countState.b };
  },
};
const reg = makeRegistry([countTickDef]);

/** start → sv1(phase=before) → tickA → tickB → sv2(phase=after) → end（无 edges 按声明顺序执行）。 */
function breakpointWorkflow(id: string): Workflow {
  return {
    id, name: "断点主流程", version: "0.1.0",
    globalVariables: { env: "test" },
    nodes: [
      makeNode("start", "start"),
      makeNode("sv1", "setVariable", { target: "workflow:phase", value: "before" }),
      countNode("tickA"),
      countNode("tickB"),
      makeNode("sv2", "setVariable", { target: "workflow:phase", value: "after" }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}
/** parent：start → loop(3 items, interpolate body) → end。 */
function loopParentWorkflow(id: string): Workflow {
  return {
    id, name: "parent", version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("loop", "loop", {
        items: ["a", "b", "c"],
        body: {
          id: "dbg-loop-body", name: "body", version: "0.1.0",
          nodes: [
            makeNode("start", "start"),
            makeNode("sv", "setVariable", { target: "workflow:endInput", value: "idx-${workflow:loopIndex}-item-${workflow:loopItem}" }),
            makeNode("end", "end"),
          ],
          edges: [],
        },
      }),
      makeNode("end", "end"),
    ],
    edges: [{ id: "e1", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" }],
  };
}
/** start → human(挂起) → end。 */
function humanWorkflow(id: string): Workflow {
  return {
    id, name: "挂起断点", version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("human", "humanTask", { title: "审批" }),
      makeNode("end", "end"),
    ],
    edges: [{ id: "e1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" }],
  };
}
function expectSnap(snap: RunState | undefined): RunState {
  if (snap === undefined) throw new Error("expected run state");
  return snap;
}
beforeEach(() => { countState.a = 0; countState.b = 0; });

describe("断点核心：命中暂停与恢复", () => {
  test("中间节点断点：paused + 节点 Paused + 断点前已执行 + 快照含 debug/三作用域", async () => {
    const dbPath = nextDbPath("pause");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const controller = new DebugController();
    controller.setBreakpoints(["tickB"]);
    const engine = new ExecutionEngine(breakpointWorkflow("dbg-pause"), {
      registry: reg, runId: "dbg-pause-1", persist: true, runStateStore: runStore,
      workflowVariables: { app: "dbg" }, debugController: controller,
    });
    const r = await engine.run();
    expect(r.status).toBe("paused");
    expect(r.pendingNodeId).toBe("tickB");
    expect(r.nodeStates["tickB"]).toBe("Paused");
    expect(r.nodeStates["sv1"]).toBe("Success");
    expect(r.nodeStates["sv2"]).toBe("Idle");
    expect(countState.a).toBe(1); // 断点前节点已执行
    expect(countState.b).toBe(0); // 断点节点未执行
    expect(engine.getWorkflowVariable("phase")).toBe("before");
    const snap = expectSnap(await runStore.getById("dbg-pause-1"));
    expect(snap.status).toBe("paused");
    expect(snap.pendingNodeId).toBe("tickB");
    expect(snap.debug?.breakpoints).toEqual(["tickB"]);
    expect(snap.contextSnapshot.global["env"]).toBe("test");
    expect(snap.contextSnapshot.workflow["phase"]).toBe("before");
    expect(snap.contextSnapshot.workflow["app"]).toBe("dbg");
    expect(snap.contextSnapshot.node).toBeDefined();
  });

  test("debugResume：断点节点执行、后续继续、断点前不重跑", async () => {
    const dbPath = nextDbPath("resume");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const controller = new DebugController();
    controller.setBreakpoints(["tickB"]);
    const r1 = await new ExecutionEngine(breakpointWorkflow("dbg-resume"), {
      registry: reg, runId: "dbg-resume-1", persist: true, runStateStore: runStore, debugController: controller,
    }).run();
    expect(r1.status).toBe("paused");
    expect(countState.b).toBe(0);
    const r2 = await debugResume("dbg-resume-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["tickB"]).toBe("Success");
    expect(r2.nodeStates["sv2"]).toBe("Success");
    expect(countState.a).toBe(1); // 断点前不重跑（无副作用重复）
    expect(countState.b).toBe(1); // 断点节点执行一次（consumeResumeNode 防死循环）
  });
});

describe("断点边界", () => {
  test("无断点 run() 全流程正常（回归）", async () => {
    const engine = new ExecutionEngine(breakpointWorkflow("dbg-reg"), { registry: reg });
    const r = await engine.run();
    expect(r.status).toBe("success");
    expect(r.nodeStates["end"]).toBe("Success");
    expect(countState.a).toBe(1);
    expect(countState.b).toBe(1);
  });

  test("断点在 loop 容器节点：命中暂停、恢复后完成", async () => {
    const dbPath = nextDbPath("loop");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const controller = new DebugController();
    controller.setBreakpoints(["loop"]);
    const r1 = await new ExecutionEngine(loopParentWorkflow("dbg-loop"), {
      registry: reg, runId: "dbg-loop-1", persist: true, runStateStore: runStore, debugController: controller,
    }).run();
    expect(r1.status).toBe("paused");
    expect(r1.pendingNodeId).toBe("loop");
    expect(r1.nodeStates["loop"]).toBe("Paused");
    expect(r1.nodeStates["end"]).toBe("Idle");
    const r2 = await debugResume("dbg-loop-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r2.status).toBe("success");
    expect(r2.nodeOutputs["loop"]?.["results"]).toEqual(["idx-0-item-a", "idx-1-item-b", "idx-2-item-c"]);
  });

  test("断点在最后节点：暂停后 resume 完成", async () => {
    const dbPath = nextDbPath("last");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const controller = new DebugController();
    controller.setBreakpoints(["end"]);
    const r1 = await new ExecutionEngine(breakpointWorkflow("dbg-last"), {
      registry: reg, runId: "dbg-last-1", persist: true, runStateStore: runStore, debugController: controller,
    }).run();
    expect(r1.status).toBe("paused");
    expect(r1.pendingNodeId).toBe("end");
    expect(r1.nodeStates["end"]).toBe("Paused");
    expect(r1.nodeStates["sv2"]).toBe("Success");
    const r2 = await debugResume("dbg-last-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["end"]).toBe("Success");
  });

  test("humanTask 挂起先于断点命中：正常 waiting 不干扰，恢复后断点命中", async () => {
    const dbPath = nextDbPath("human");
    const sharedDb = await openDatabase(dbPath); sharedDbs.push(sharedDb); sharedDb.ensureSchema();
    const runStore: RunStateStoreLike = new SqliteRunStateStore(dbPath, sharedDb);
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const controller = new DebugController();
    controller.setBreakpoints(["end"]);
    const engine = new ExecutionEngine(humanWorkflow("dbg-human"), {
      registry: reg, runId: "dbg-human-1", persist: true, runStateStore: runStore,
      humanTaskStore: humanStore, debugController: controller,
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("waiting"); // 挂起先于断点命中，断点不干扰
    const task = r1.waitingTask;
    expect(task).toBeDefined();
    const r2 = await engine.resume(task!.id, "ok");
    expect(r2.status).toBe("paused"); // 恢复后 end 断点命中
    expect(r2.pendingNodeId).toBe("end");
    const r3 = await debugResume("dbg-human-1", { registry: reg, runStateStore: runStore, humanTaskStore: humanStore, persist: true });
    expect(r3.status).toBe("success");
    expect(r3.nodeStates["end"]).toBe("Success");
  });
});
