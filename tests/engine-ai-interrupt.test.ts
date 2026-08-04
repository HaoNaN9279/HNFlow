// 引擎 AI 中断挂起/恢复集成测试（v0.2.1 AC3/AC4）：假 ai 执行器 + 假 resume handler，不依赖真实 langchain。
// 覆盖：中断挂起三写同事务（checkpoint+HumanTask+RunState）、失败回滚、approve/reject 恢复、
// 恢复失败 reopen 回 pending（用户输入保留）、多轮中断复用同一任务、skip 转 reject 决策。
import { afterAll, describe, expect, test } from "bun:test";
import { AiInterruptRequiredError, type AIExecutionResult } from "../src/ai/executor.js";
import { SqliteCheckpointSaver } from "../src/ai/checkpoint-saver.js";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { SqliteHumanTaskStore, SqliteRunStateStore } from "../src/db/stores.js";
import { openDatabase, type SqliteDatabase } from "../src/db/index.js";
import { ExecutionEngine, type AIResumeContext } from "../src/execution/Engine.js";
import type { INodeDefinition, NodeExecutionContext } from "../src/execution/types.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";
import type { RunState } from "../src/runstate/types.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";

/** AI 中断线程标识（假执行器固定值，恢复时回传）。 */
const THREAD_ID = "ai-interrupt-thread";

/** 构造 v4 格式 Checkpoint（哨兵 checkpoint 用，模式同 checkpoint-saver.test.ts）。 */
function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };
}

/** 构造 CheckpointMetadata（哨兵 checkpoint 用）。 */
function makeMetadata(step: number): CheckpointMetadata {
  return { source: "loop", step, parents: {} };
}

/** 用真实 SqliteCheckpointSaver 写一条哨兵 checkpoint（sharedDb 连接，可参与外层事务）。 */
async function writeSentinel(sharedDb: SqliteDatabase, threadId: string, checkpointId: string, step: number): Promise<void> {
  const saver = new SqliteCheckpointSaver("ignored.db", sharedDb);
  await saver.put(
    { configurable: { thread_id: threadId } },
    makeCheckpoint(checkpointId),
    makeMetadata(step),
    {},
  );
}

/** 统计指定线程的 checkpoint 行数（验证事务提交/回滚）。 */
function countCheckpoints(sharedDb: SqliteDatabase, threadId: string): number {
  const row = sharedDb.db.prepare("SELECT COUNT(*) AS c FROM checkpoints WHERE thread_id = ?").get(threadId);
  return typeof row === "object" && row !== null ? Number((row as { c: unknown }).c) : 0;
}

/** 假 ai 节点执行状态：execute 次数 + 中断次数 + 后续成功输出。 */
interface FakeAiState {
  executeCalls: number;
  interruptCalls: number;
}

/** 构造假 ai 节点定义：前 interrupts 次 execute 写哨兵 checkpoint 并抛 AiInterruptRequiredError，之后返回成功。 */
function makeFakeAiDef(
  sharedDb: SqliteDatabase,
  opts: { readonly interrupts: number },
): { readonly def: INodeDefinition; readonly state: FakeAiState } {
  const state: FakeAiState = { executeCalls: 0, interruptCalls: 0 };
  const def: INodeDefinition = {
    type: "ai",
    name: "AI 节点",
    inputs: [],
    outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
    async execute(_ctx: NodeExecutionContext) {
      state.executeCalls += 1;
      if (state.executeCalls <= opts.interrupts) {
        state.interruptCalls += 1;
        const checkpointId = `cp-exec-${state.executeCalls}`;
        await writeSentinel(sharedDb, THREAD_ID, checkpointId, state.executeCalls);
        throw new AiInterruptRequiredError(
          { actionRequests: [{ name: "getWeather", args: { city: "北京" } }] },
          THREAD_ID,
          checkpointId,
          `审批：getWeather({"city":"北京"})`,
        );
      }
      return { output: "ai done", messages: [], toolCalls: [] };
    },
  };
  return { def, state };
}

/** 假 resume handler 行为脚本。 */
type HandlerBehavior = "success" | "fail" | "interrupt";

interface FakeHandler {
  handler: (ctx: AIResumeContext) => Promise<AIExecutionResult>;
  calls: AIResumeContext[];
}

/** 构造假 resume handler：按行为脚本逐次响应（超出取最后一个）。interrupt 写新哨兵并抛再中断信号。 */
function makeFakeHandler(
  sharedDb: SqliteDatabase,
  behaviors: readonly HandlerBehavior[],
): FakeHandler {
  const calls: AIResumeContext[] = [];
  let interruptCalls = 0;
  const handler = async (ctx: AIResumeContext): Promise<AIExecutionResult> => {
    calls.push(ctx);
    const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)];
    if (behavior === "fail") {
      throw new Error("resume handler 模拟失败");
    }
    if (behavior === "interrupt") {
      interruptCalls += 1;
      const checkpointId = `cp-resume-${interruptCalls}`;
      await writeSentinel(sharedDb, ctx.threadId, checkpointId, interruptCalls);
      throw new AiInterruptRequiredError(
        { actionRequests: [{ name: "getWeather", args: { city: "上海" } }] },
        ctx.threadId,
        checkpointId,
        `审批：getWeather({"city":"上海"})`,
      );
    }
    return { output: "resumed ok", messages: [], toolCalls: [] };
  };
  return { handler, calls };
}

/** 基于内置节点（排除 ai）+ 自定义 ai 定义构造独立 registry。 */
function makeRegistry(aiDef: INodeDefinition): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) {
    if (def.type === "ai") continue;
    reg.register(def);
  }
  reg.register(aiDef);
  return reg;
}

/** 构造 ai 节点（用自定义 registry 拿端口模板）。 */
function makeAiNode(reg: NodeRegistry, id: string): Node {
  const def = reg.get("ai");
  return { id, type: "ai", name: id, params: {}, inputs: def.inputs, outputs: def.outputs };
}

/** start → ai → log → end。 */
function makeAiWorkflow(reg: NodeRegistry): Workflow {
  return {
    id: "ai-interrupt-wf",
    name: "ai-interrupt",
    version: "0.1.0",
    nodes: [
      { id: "start", type: "start", name: "start", params: {}, inputs: reg.get("start").inputs, outputs: reg.get("start").outputs },
      makeAiNode(reg, "ai"),
      { id: "log", type: "log", name: "log", params: { level: "info", message: "after ai" }, inputs: reg.get("log").inputs, outputs: reg.get("log").outputs },
      { id: "end", type: "end", name: "end", params: {}, inputs: reg.get("end").inputs, outputs: reg.get("end").outputs },
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ai", targetPortId: "in" },
      { id: "e2", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "log", targetPortId: "in" },
      { id: "e3", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 收窄 waiting 结果并返回任务。 */
function expectWaiting(result: { status: string; waitingTask?: HumanTask }): HumanTask {
  if (result.status !== "waiting") {
    throw new Error(`expected waiting status, got: ${result.status}`);
  }
  const task = result.waitingTask;
  if (task === undefined) {
    throw new Error("expected waitingTask in result");
  }
  return task;
}

/** RunState update 包装：status=waiting 时抛错（模拟挂起三写中途失败）。 */
class FailWaitingRunStore implements RunStateStoreLike {
  constructor(private readonly inner: RunStateStoreLike) {}
  async create(run: RunState): Promise<void> {
    return this.inner.create(run);
  }
  async update(run: RunState): Promise<void> {
    if (run.status === "waiting") {
      throw new Error("模拟 RunState 写入失败");
    }
    return this.inner.update(run);
  }
  async getById(runId: string): Promise<RunState | undefined> {
    return this.inner.getById(runId);
  }
  async list(): Promise<RunState[]> {
    return this.inner.list();
  }
  async listByWorkflow(workflowId: string): Promise<RunState[]> {
    return this.inner.listByWorkflow(workflowId);
  }
}

const sharedDbs: SqliteDatabase[] = [];
afterAll(() => {
  for (const db of sharedDbs) db.close();
});

describe("AI 中断挂起：三写同事务", () => {
  test("run 中断 → waiting + HumanTask（meta 含 threadId/checkpointId）+ RunState waiting + checkpoint 落库", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def, state } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const handler = makeFakeHandler(sharedDb, ["success"]);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-run-1",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
    });

    const result = await engine.run();
    expect(result.status).toBe("waiting");
    const task = expectWaiting(result);
    expect(task.title).toContain("getWeather");
    expect(task.meta?.["kind"]).toBe("ai_interrupt");
    expect(task.meta?.["threadId"]).toBe(THREAD_ID);
    expect(task.meta?.["checkpointId"]).toBe("cp-exec-1");
    expect(result.nodeStates["ai"]).toBe("WaitingForHuman");
    expect(result.nodeStates["log"]).toBe("Idle");
    // 假执行器确实抛过中断（executor 语义由 T4 测试覆盖，此处验证引擎侧）。
    expect(state.interruptCalls).toBe(1);
    // AC3：checkpoint（executor 内写入）+ HumanTask + RunState 同一事务提交后均落库。
    expect(countCheckpoints(sharedDb, THREAD_ID)).toBe(1);
    // 未显式注入 store：引擎用 sharedDb 自动构造（getter 逻辑）→ 同连接直查可见。
    const row = sharedDb.db.prepare("SELECT status FROM human_tasks WHERE id = ?").get(task.id);
    expect((row as { status: unknown }).status).toBe("pending");
    const runRow = sharedDb.db.prepare("SELECT status FROM run_state WHERE run_id = ?").get("ai-run-1");
    expect((runRow as { status: unknown }).status).toBe("waiting");
    const snap = JSON.parse(
      (sharedDb.db.prepare("SELECT state FROM run_state WHERE run_id = ?").get("ai-run-1") as { state: string }).state,
    ) as { pendingNodeId?: string; pendingTaskId?: string };
    expect(snap.pendingNodeId).toBe("ai");
    expect(snap.pendingTaskId).toBe(task.id);
  });

  test("挂起三写中途失败 → 全部回滚：HumanTask 与 checkpoint 均不落库，节点 Failed", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const humanStore = new SqliteHumanTaskStore("ignored.db", sharedDb);
    const runStore = new SqliteRunStateStore("ignored.db", sharedDb);
    const failingRunStore = new FailWaitingRunStore(runStore);
    const handler = makeFakeHandler(sharedDb, ["success"]);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-run-rb",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
      humanTaskStore: humanStore,
      runStateStore: failingRunStore,
    });

    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["ai"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("模拟 RunState 写入失败");
    // AC3 回滚：checkpoint 与 HumanTask 均未落库。
    expect(countCheckpoints(sharedDb, THREAD_ID)).toBe(0);
    expect(await humanStore.listAll()).toHaveLength(0);
  });
});

describe("AI 中断恢复", () => {
  test("resume approve → handler 收到 decisions → 继续下游 success", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const handler = makeFakeHandler(sharedDb, ["success"]);
    const humanStore = new SqliteHumanTaskStore("ignored.db", sharedDb);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-resume-ok",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
      humanTaskStore: humanStore,
    });

    const task = expectWaiting(await engine.run());
    const resumed = await engine.resume(task.id, { type: "approve" });
    expect(resumed.status).toBe("success");
    expect(resumed.nodeStates["ai"]).toBe("Success");
    expect(resumed.nodeStates["log"]).toBe("Success");
    expect(resumed.nodeStates["end"]).toBe("Success");
    expect(engine.logs.some((entry) => entry.message === "after ai")).toBe(true);
    // handler 收到 decisions。
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0]?.decisions).toEqual([{ type: "approve" }]);
    expect(handler.calls[0]?.threadId).toBe(THREAD_ID);
    expect(handler.calls[0]?.checkpointId).toBe("cp-exec-1");
    // 任务 completed + result。
    const stored = await humanStore.getById(task.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.result).toEqual({ type: "approve" });
  });

  test("resume reject → handler 收到 reject + message → 继续", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const handler = makeFakeHandler(sharedDb, ["success"]);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-resume-reject",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
    });

    const task = expectWaiting(await engine.run());
    const resumed = await engine.resume(task.id, { type: "reject", message: "不要调用" });
    expect(resumed.status).toBe("success");
    expect(handler.calls[0]?.decisions).toEqual([{ type: "reject", message: "不要调用" }]);
  });

  test("恢复失败 → 任务 reopen 回 pending，用户输入保留（AC4），可重试", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const handler = makeFakeHandler(sharedDb, ["fail"]);
    const humanStore = new SqliteHumanTaskStore("ignored.db", sharedDb);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-resume-fail",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
      humanTaskStore: humanStore,
    });

    const task = expectWaiting(await engine.run());
    await expect(engine.resume(task.id, { type: "approve" })).rejects.toThrow("resume handler 模拟失败");
    // AC4：任务回退 pending，用户输入（result）保留。
    const stored = await humanStore.getById(task.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.result).toEqual({ type: "approve" });
    expect(stored?.completedAt).toBeUndefined();
    // 重试可直接复用（不传 result 回退 task.result）。
    const handler2 = makeFakeHandler(sharedDb, ["success"]);
    const engine2 = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-resume-fail",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler2.handler,
      humanTaskStore: humanStore,
    });
    const retried = await engine2.resume(task.id);
    expect(retried.status).toBe("success");
    expect(handler2.calls[0]?.decisions).toEqual([{ type: "approve" }]);
  });
});

describe("AI 中断多轮审批", () => {
  test("第二次中断复用同一任务 id（reopen + 更新 meta 为新 checkpointId）", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const handler = makeFakeHandler(sharedDb, ["interrupt"]);
    const humanStore = new SqliteHumanTaskStore("ignored.db", sharedDb);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-multi-round",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
      humanTaskStore: humanStore,
    });

    const task = expectWaiting(await engine.run());
    expect(await humanStore.listAll()).toHaveLength(1);
    // resume approve → 恢复后 agent 再次中断 → 复用同一任务。
    const round2 = await engine.resume(task.id, { type: "approve" });
    expect(round2.status).toBe("waiting");
    const round2Task = expectWaiting(round2);
    expect(round2Task.id).toBe(task.id); // 同一任务 id
    expect(await humanStore.listAll()).toHaveLength(1); // 无新任务
    // meta 更新为新 checkpointId，任务回 pending。
    const stored = await humanStore.getById(task.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.meta?.["checkpointId"]).toBe("cp-resume-1");
    expect(stored?.meta?.["threadId"]).toBe(THREAD_ID);
    // 第二轮的 checkpoint 落库（事务提交）。
    expect(countCheckpoints(sharedDb, THREAD_ID)).toBe(2);
    // 第二轮审批后可继续恢复。
    const handler3 = makeFakeHandler(sharedDb, ["success"]);
    const engine3 = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-multi-round",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler3.handler,
      humanTaskStore: humanStore,
    });
    const final = await engine3.resume(task.id, { type: "reject", message: "够了" });
    expect(final.status).toBe("success");
    expect(handler3.calls[0]?.checkpointId).toBe("cp-resume-1");
    expect(handler3.calls[0]?.decisions).toEqual([{ type: "reject", message: "够了" }]);
  });
});

describe("AI 中断跳过", () => {
  test("skip AI 任务 → handler 收到 reject 决策 → agent 继续完成", async () => {
    const sharedDb = await openDatabase(":memory:");
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const { def } = makeFakeAiDef(sharedDb, { interrupts: 1 });
    const reg = makeRegistry(def);
    const handler = makeFakeHandler(sharedDb, ["success"]);
    const humanStore = new SqliteHumanTaskStore("ignored.db", sharedDb);
    const engine = new ExecutionEngine(makeAiWorkflow(reg), {
      registry: reg,
      persist: true,
      runId: "ai-skip",
      aiCheckpoint: { dbPath: "ignored.db", sharedDb },
      aiResumeHandler: handler.handler,
      humanTaskStore: humanStore,
    });

    const task = expectWaiting(await engine.run());
    const skipped = await engine.skip(task.id);
    expect(skipped.status).toBe("success");
    expect(handler.calls[0]?.decisions).toEqual([{ type: "reject", message: "用户跳过" }]);
    expect(skipped.nodeStates["ai"]).toBe("Success");
    expect(skipped.nodeStates["log"]).toBe("Success");
    const stored = await humanStore.getById(task.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.result).toEqual({ type: "reject", message: "用户跳过" });
  });
});
