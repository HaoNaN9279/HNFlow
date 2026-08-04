// 单步执行 e2e（v0.2.4 T3）：Step Over / Step Into / Continue + 子引擎调试控制器透传 + SubworkflowPausedError 冒泡。
// 独立 NodeRegistry（countTick 计数节点验证执行次序）；SQLite 临时库；isContainer 经 Engine options 注入；挂起显式传 humanTaskStore。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { debugResume, resumeTask } from "../src/execution/resume.js";
import { DebugController } from "../src/execution/DebugController.js";
import { openDatabase, SqliteHumanTaskStore, SqliteRunStateStore, type SqliteDatabase } from "../src/db/index.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\debug-step-test";
let fileCounter = 0;
function nextDbPath(prefix: string): string { return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`); }
const sharedDbs: SqliteDatabase[] = [];
beforeAll(async () => { await mkdir(TEMP_BASE, { recursive: true }); });
afterAll(async () => { for (const db of sharedDbs) db.close(); await rmRetry(TEMP_BASE); }, 30000);
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) { Bun.gc(true); await new Promise((resolve) => setTimeout(resolve, 200)); continue; }
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
/** SQLite 临时库 + RunStateStore（每个测试独立）。 */
async function setupStore(prefix: string): Promise<{ dbPath: string; runStore: RunStateStoreLike; sharedDb: SqliteDatabase }> {
  const dbPath = nextDbPath(prefix);
  const sharedDb = await openDatabase(dbPath);
  sharedDbs.push(sharedDb);
  sharedDb.ensureSchema();
  return { dbPath, runStore: new SqliteRunStateStore(dbPath, sharedDb), sharedDb };
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
  type: "countTick", name: "countTick", inputs: [],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    if (ctx.node.id === "tickA") return { out: ++countState.a };
    return { out: ++countState.b };
  },
};
const reg = makeRegistry([countTickDef]);
const isContainer = (nodeId: string): boolean => nodeId === "sub"; // 容器 id 判定：step-into 放行容器进入子图
/** start → sv1 → tickA → tickB → sv2 → end（无 edges 按声明顺序执行）。 */
function stepWorkflow(id: string): Workflow {
  return {
    id, name: "单步主流程", version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv1", "setVariable", { target: "workflow:phase", value: "before" }),
      countNode("tickA"), countNode("tickB"),
      makeNode("sv2", "setVariable", { target: "workflow:phase", value: "after" }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}
/** parent：start → sub(subworkflow: start→sv→end) → end2（子图 endResult 透传 out）。 */
function subParentWorkflow(id: string): Workflow {
  return {
    id, name: "sub-parent", version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sub", "subworkflow", {
        subworkflow: { id: "sub-wf", name: "子图", version: "0.1.0", nodes: [
          makeNode("start", "start"),
          makeNode("sv", "setVariable", { target: "workflow:endInput", value: "from-sub" }),
          makeNode("end", "end"),
        ], edges: [] },
      }),
      makeNode("end2", "end"),
    ],
    edges: [{ id: "e1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end2", targetPortId: "in" }],
  };
}
/** parent：start → sub(subworkflow: start→human→end) → end2（挂起场景）。 */
function waitSubParentWorkflow(id: string): Workflow {
  return {
    id, name: "wait-parent", version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sub", "subworkflow", {
        subworkflow: { id: "wait-sub-wf", name: "挂起子图", version: "0.1.0", nodes: [
          makeNode("start", "start"),
          makeNode("human", "humanTask", { title: "子图审批" }),
          makeNode("end", "end"),
        ], edges: [{ id: "e1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" }] },
      }),
      makeNode("end2", "end"),
    ],
    edges: [{ id: "e2", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end2", targetPortId: "in" }],
  };
}
beforeEach(() => { countState.a = 0; countState.b = 0; });

describe("Step Over", () => {
  test("断点 tickA → stepOver：tickA 执行、下一拓扑序节点 tickB 暂停 → continue 完成", async () => {
    const { runStore } = await setupStore("over");
    const controller = new DebugController();
    controller.setBreakpoints(["tickA"]);
    const r1 = await new ExecutionEngine(stepWorkflow("dbg-step-over"), {
      registry: reg, runId: "dbg-step-over-1", persist: true, runStateStore: runStore, debugController: controller, isContainer,
    }).run();
    expect(r1.status).toBe("paused");
    expect(r1.pendingNodeId).toBe("tickA");
    expect(countState.a).toBe(0);
    const r2 = await debugResume("dbg-step-over-1", { registry: reg, runStateStore: runStore, persist: true, step: { mode: "over" }, isContainer });
    expect(r2.status).toBe("paused");
    expect(r2.pendingNodeId).toBe("tickB");
    expect(r2.nodeStates["tickA"]).toBe("Success");
    expect(countState.a).toBe(1);
    expect(countState.b).toBe(0);
    const r3 = await debugResume("dbg-step-over-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r3.status).toBe("success");
    expect(countState.b).toBe(1);
  });
});

describe("Continue", () => {
  test("断点 sv1+sv2：continue 直达下一断点 sv2（中间节点不暂停）→ 完成", async () => {
    const { runStore } = await setupStore("cont");
    const controller = new DebugController();
    controller.setBreakpoints(["sv1", "sv2"]);
    const r1 = await new ExecutionEngine(stepWorkflow("dbg-step-cont"), {
      registry: reg, runId: "dbg-step-cont-1", persist: true, runStateStore: runStore, debugController: controller, isContainer,
    }).run();
    expect(r1.status).toBe("paused"); expect(r1.pendingNodeId).toBe("sv1");
    const r2 = await debugResume("dbg-step-cont-1", { registry: reg, runStateStore: runStore, persist: true, step: { mode: "continue" }, isContainer });
    expect(r2.status).toBe("paused");
    expect(r2.pendingNodeId).toBe("sv2");
    expect(r2.nodeStates["tickA"]).toBe("Success");
    expect(r2.nodeStates["tickB"]).toBe("Success");
    expect(countState.a).toBe(1);
    expect(countState.b).toBe(1);
    const r3 = await debugResume("dbg-step-cont-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r3.status).toBe("success");
  });

  test("无单步意图恢复（缺省 continue）= 到下一断点", async () => {
    const { runStore } = await setupStore("def");
    const controller = new DebugController();
    controller.setBreakpoints(["tickA", "sv2"]);
    const r1 = await new ExecutionEngine(stepWorkflow("dbg-step-def"), {
      registry: reg, runId: "dbg-step-def-1", persist: true, runStateStore: runStore, debugController: controller, isContainer,
    }).run();
    expect(r1.pendingNodeId).toBe("tickA");
    const r2 = await debugResume("dbg-step-def-1", { registry: reg, runStateStore: runStore, persist: true, isContainer });
    expect(r2.status).toBe("paused");
    expect(r2.pendingNodeId).toBe("sv2");
    expect(r2.nodeStates["tickB"]).toBe("Success");
    const r3 = await debugResume("dbg-step-def-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r3.status).toBe("success");
  });
});

describe("Step Into", () => {
  test("断点 sub 容器 → stepInto：子图首节点暂停（pendingNodeId=子图start、pausedWorkflowId 含路径）→ continue 子图完成", async () => {
    const { runStore } = await setupStore("into");
    const controller = new DebugController();
    controller.setBreakpoints(["sub"]);
    const r1 = await new ExecutionEngine(subParentWorkflow("dbg-step-into"), {
      registry: reg, runId: "dbg-step-into-1", persist: true, runStateStore: runStore, debugController: controller, isContainer,
    }).run();
    expect(r1.status).toBe("paused");
    expect(r1.pendingNodeId).toBe("sub"); expect(r1.nodeStates["sub"]).toBe("Paused");
    const r2 = await debugResume("dbg-step-into-1", { registry: reg, runStateStore: runStore, persist: true, step: { mode: "into" }, isContainer });
    expect(r2.status).toBe("paused");
    expect(r2.pendingNodeId).toBe("start"); // 子图首节点（SubworkflowPausedError 冒泡）
    expect(r2.nodeStates["sub"]).toBe("Paused"); // 容器整体暂停
    const snap2 = await runStore.getById("dbg-step-into-1");
    expect(snap2?.status).toBe("paused");
    expect(snap2?.pendingNodeId).toBe("start");
    expect(snap2?.debug?.pausedWorkflowId).toContain("dbg-step-into:sub"); // workflowId 链含子图路径
    const r3 = await debugResume("dbg-step-into-1", { registry: reg, runStateStore: runStore, persist: true, isContainer });
    expect(r3.status).toBe("success");
    expect(r3.nodeOutputs["sub"]?.["out"]).toBe("from-sub");
    expect(r3.nodeStates["sub"]).toBe("Success");
  });
});

describe("Step Over 跨容器", () => {
  test("断点 sub 容器 → stepOver：容器整体执行完、下一节点 end2 暂停（子图内部不暂停）→ continue 完成", async () => {
    const { runStore } = await setupStore("over-sub");
    const controller = new DebugController();
    controller.setBreakpoints(["sub"]);
    const r1 = await new ExecutionEngine(subParentWorkflow("dbg-step-over-sub"), {
      registry: reg, runId: "dbg-step-over-sub-1", persist: true, runStateStore: runStore, debugController: controller, isContainer,
    }).run();
    expect(r1.status).toBe("paused");
    expect(r1.pendingNodeId).toBe("sub");
    const r2 = await debugResume("dbg-step-over-sub-1", { registry: reg, runStateStore: runStore, persist: true, step: { mode: "over" }, isContainer });
    expect(r2.status).toBe("paused");
    expect(r2.pendingNodeId).toBe("end2"); // 子图整体执行完，下一父级节点暂停
    expect(r2.nodeStates["sub"]).toBe("Success");
    const r3 = await debugResume("dbg-step-over-sub-1", { registry: reg, runStateStore: runStore, persist: true });
    expect(r3.status).toBe("success");
  });
});

describe("单步与挂起交互", () => {
  test("step-into 子图内 humanTask 挂起 → waiting 优先，任务 workflowId 含子图路径", async () => {
    const { dbPath, runStore, sharedDb } = await setupStore("wait");
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const controller = new DebugController();
    controller.setBreakpoints(["sub"]);
    const r1 = await new ExecutionEngine(waitSubParentWorkflow("dbg-step-wait"), {
      registry: reg, runId: "dbg-step-wait-1", persist: true, runStateStore: runStore,
      humanTaskStore: humanStore, debugController: controller, isContainer,
    }).run();
    expect(r1.status).toBe("paused");
    expect(r1.pendingNodeId).toBe("sub");
    const r2 = await debugResume("dbg-step-wait-1", { registry: reg, runStateStore: runStore, humanTaskStore: humanStore, persist: true, step: { mode: "into" }, isContainer });
    expect(r2.status).toBe("paused");
    expect(r2.pendingNodeId).toBe("start"); // 子图首节点暂停
    const r3 = await debugResume("dbg-step-wait-1", { registry: reg, runStateStore: runStore, humanTaskStore: humanStore, persist: true, isContainer });
    expect(r3.status).toBe("waiting"); // waiting 优先于断点
    const task = r3.waitingTask;
    expect(task).toBeDefined();
    expect(task!.workflowId).toBe("dbg-step-wait:sub"); // workflowId 链含子图路径
    const r4 = await resumeTask(task!.id, { registry: reg, runStateStore: runStore, humanTaskStore: humanStore, persist: true }, "approve");
    expect(r4.status).toBe("success");
  });
});
