// AI 中断端到端集成测试（v0.2.1 AC1-AC5）：真实 ExecutionEngine + LangGraphExecutor +
// FakeLLM + SqliteCheckpointSaver 共享连接。覆盖单次/多次/循环中断审批、reject 决策、
// 三写同事务一致性与回滚、恢复失败回退 pending、llm 节点统一运行时。
// FakeLLM 连续性关键：ai 节点内部 resolveModel 新建实例（execute 脚本只需覆盖到首次中断）；
// resume 走 handler 闭包持有的独立 FakeLLM 实例——脚本设计为"恢复后从第一次模型调用开始"的续写，
// 且同一 handler 跨多次 resume 共享该实例（多轮中断 callIndex 连续）。
// 【T5.1 修复】Engine.createNodeContext 注入 aiCheckpoint → ai 节点从 ctx 组装 checkpointDb，
// 本测试全程走真实引擎 + 真实 ai 节点 + interrupt 路径（无包装注入，无 checkpointDb 补丁）。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { aiExecutor } from "../src/ai/executor-instance.js";
import type { AIExecutionResult, AIInterruptConfig } from "../src/ai/executor.js";
import { SqliteCheckpointSaver } from "../src/ai/checkpoint-saver.js";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import { resolveModel } from "../src/ai/model.js";
import type { HNFlowTool } from "../src/ai/types.js";
import { clearTools, registerTool } from "../src/ai/toolRegistry.js";
import { openDatabase, SqliteHumanTaskStore, SqliteRunStateStore, type SqliteDatabase } from "../src/db/index.js";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import { ExecutionEngine, type AIResumeContext } from "../src/execution/Engine.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\ai-interrupt-e2e-test";
let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterEach(() => {
  clearTools();
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows bun:sqlite 句柄释放依赖 GC，强制回收以解锁文件
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

/** 工具调用计数：handler 实际被调用次数（reject 路径断言为 0 用）。 */
interface CallCount {
  count: number;
}

function makeWeatherTool(calls: CallCount): HNFlowTool {
  return {
    name: "demo.getWeather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: (input) => {
      calls.count += 1;
      return `天气: ${input["city"] ?? ""} 晴`;
    },
  };
}

function makeSearchTool(calls: CallCount): HNFlowTool {
  return {
    name: "demo.search",
    description: "搜索",
    parameters: z.object({ q: z.string() }),
    handler: (input) => {
      calls.count += 1;
      return `搜索: ${input["q"] ?? ""}`;
    },
  };
}

/** 脚本步骤：tool_call 必须用完整命名空间名（v0.2.0 已知坑）。 */
const weatherCall: FakeScriptStep = { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "上海" } } };
const searchCall: FakeScriptStep = { kind: "tool_call", toolCall: { name: "demo.search", args: { q: "HNFlow" } } };

/** 全部工具默认审批的中断配置。 */
function interruptConfig(names: readonly string[]): AIInterruptConfig {
  const interruptOn: Record<string, { allowedDecisions: readonly ("approve" | "reject")[] }> = {};
  for (const name of names) {
    interruptOn[name] = { allowedDecisions: ["approve", "reject"] };
  }
  return { interruptOn };
}

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

interface WfNode { readonly id: string; readonly type: string; readonly params?: Readonly<Record<string, unknown>>; }
interface WfEdge { readonly src: string; readonly srcPort: string; readonly dst: string; readonly dstPort: string; }

function buildWorkflow(id: string, nodes: readonly WfNode[], edges: readonly WfEdge[]): Workflow {
  return {
    id,
    name: id,
    version: "0.1.0",
    nodes: nodes.map((n) => makeNode(n.id, n.type, n.params ?? {})),
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      sourceNodeId: e.src,
      sourcePortId: e.srcPort,
      targetNodeId: e.dst,
      targetPortId: e.dstPort,
    })),
  };
}

/** start → ai → end：end 经 in 端口把 ai output 写入 workflow:endResult。 */
function aiWorkflow(id: string, aiParams: Readonly<Record<string, unknown>>): Workflow {
  return buildWorkflow(id, [
    { id: "start", type: "start" },
    { id: "ai", type: "ai", params: aiParams },
    { id: "end", type: "end" },
  ], [
    { src: "start", srcPort: "data", dst: "ai", dstPort: "in" },
    { src: "ai", srcPort: "output", dst: "end", dstPort: "in" },
  ]);
}

type ResumeHandler = (ctx: AIResumeContext) => Promise<AIExecutionResult>;

/** 组装真实 resume handler：闭包持有 model/tools/interrupt（参考 ai 节点 execute 的 request 组装），
 *  引擎传 thread/checkpoint/decisions，经 aiExecutor.resume 重建 agent 恢复执行。 */
function makeResumeHandler(opts: {
  readonly dbPath: string;
  readonly sharedDb: SqliteDatabase;
  readonly model: ReturnType<typeof resolveModel>;
  readonly tools: readonly HNFlowTool[];
  readonly interrupt?: AIInterruptConfig;
  readonly failFirst?: number;
}): ResumeHandler {
  let calls = 0;
  const resume = async (ctx: AIResumeContext): Promise<AIExecutionResult> =>
    aiExecutor.resume({
      model: opts.model,
      tools: opts.tools,
      threadId: ctx.threadId,
      checkpointId: ctx.checkpointId,
      decisions: ctx.decisions,
      ...(opts.interrupt !== undefined ? { interrupt: opts.interrupt } : {}),
      checkpointDb: { dbPath: opts.dbPath, sharedDb: opts.sharedDb },
    });
  return async (ctx) => {
    calls += 1;
    if (opts.failFirst !== undefined && calls <= opts.failFirst) {
      throw new Error("模拟 agent 恢复失败");
    }
    return resume(ctx);
  };
}

/** 引擎注入 SQLite 共享连接版 store + 真实 handler；persist 开启（AC3 三写同事务）。 */
function makeEngine(workflow: Workflow, sharedDb: SqliteDatabase, opts: {
  readonly dbPath: string;
  readonly runId: string;
  readonly handler: ResumeHandler;
  readonly runStateStore?: RunStateStoreLike;
}): ExecutionEngine {
  return new ExecutionEngine(workflow, {
    persist: true,
    runId: opts.runId,
    aiCheckpoint: { dbPath: opts.dbPath, sharedDb },
    aiResumeHandler: opts.handler,
    humanTaskStore: new SqliteHumanTaskStore(opts.dbPath, sharedDb),
    runStateStore: opts.runStateStore ?? new SqliteRunStateStore(opts.dbPath, sharedDb),
  });
}

function expectWaiting(result: { status: string; waitingTask?: HumanTask }): HumanTask {
  if (result.status !== "waiting") throw new Error(`expected waiting status, got: ${result.status}`);
  if (result.waitingTask === undefined) throw new Error("expected waitingTask in result");
  return result.waitingTask;
}

/** 统计指定线程的 checkpoint 行数（验证事务提交/回滚）。 */
function countCheckpoints(sharedDb: SqliteDatabase, threadId: string): number {
  const row = sharedDb.db.prepare("SELECT COUNT(*) AS c FROM checkpoints WHERE thread_id = ?").get(threadId);
  return typeof row === "object" && row !== null ? Number((row as { c: unknown }).c) : 0;
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
afterAll(async () => {
  for (const db of sharedDbs) db.close();
  await rmRetry(TEMP_BASE);
}, 30000);

describe("AC1 单次中断 → 审批恢复", () => {
  test("run 中断 → HumanTask 落库 → approve 恢复 → success，output/后继正确", async () => {
    const dbPath = nextDbPath("ac1");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    const wf = aiWorkflow("ac1-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "上海天气？",
      tools: ["demo.getWeather"],
      interrupt: interruptConfig(["demo.getWeather"]),
    });
    // execute 用节点内 FakeLLM（消耗第 0 步 tool_call 后中断）；resume 用 handler 独立实例续写。
    const resumeModel = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "text", text: "最终回答：上海晴，25 度" }],
    });
    const engine = makeEngine(wf, sharedDb, {
      dbPath,
      runId: "ac1-run",
      handler: makeResumeHandler({
        dbPath,
        sharedDb,
        model: resumeModel,
        tools: [makeWeatherTool(weatherCalls)],
        interrupt: interruptConfig(["demo.getWeather"]),
      }),
    });

    const task = expectWaiting(await engine.run());
    expect(task.meta?.["kind"]).toBe("ai_interrupt");
    expect(task.meta?.["threadId"]).toBe("ac1-wf:ai");
    expect(task.meta?.["checkpointId"]).not.toBe("");
    const stored = await engine.humanTaskStore.getById(task.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.meta?.["kind"]).toBe("ai_interrupt");
    expect(weatherCalls.count).toBe(0); // 中断发生在工具执行前

    const resumed = await engine.resume(task.id, { type: "approve" });
    expect(resumed.status).toBe("success");
    expect(resumed.nodeStates["ai"]).toBe("Success");
    expect(resumed.nodeStates["end"]).toBe("Success");
    expect(resumed.nodeOutputs["ai"]?.["output"]).toBe("最终回答：上海晴，25 度");
    // 后继节点收到上游 output（end 经 in 端口写 workflow:endResult）。
    expect(engine.getWorkflowVariable("endResult")).toBe("最终回答：上海晴，25 度");
    expect(weatherCalls.count).toBe(1); // approve 后工具真正执行
  });
});

describe("AC2 多次/循环中断", () => {
  test("AC2a 两次不同工具中断：复用同一任务 id，meta.checkpointId 更新，最终 success", async () => {
    const dbPath = nextDbPath("ac2a");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    const searchCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    registerTool(makeSearchTool(searchCalls));
    const wf = aiWorkflow("ac2a-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "查天气再搜索",
      tools: ["demo.getWeather", "demo.search"],
      interrupt: interruptConfig(["demo.getWeather", "demo.search"]),
    });
    const resumeModel = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [searchCall, { kind: "text", text: "完成" }],
    });
    const engine = makeEngine(wf, sharedDb, {
      dbPath,
      runId: "ac2a-run",
      handler: makeResumeHandler({
        dbPath,
        sharedDb,
        model: resumeModel,
        tools: [makeWeatherTool(weatherCalls), makeSearchTool(searchCalls)],
        interrupt: interruptConfig(["demo.getWeather", "demo.search"]),
      }),
    });

    const task = expectWaiting(await engine.run());
    expect(await engine.humanTaskStore.listAll()).toHaveLength(1);
    // resume approve → 恢复后 agent 再调 demo.search → 再中断（同一任务复用）。
    const round2 = await engine.resume(task.id, { type: "approve" });
    expect(round2.status).toBe("waiting");
    const round2Task = expectWaiting(round2);
    expect(round2Task.id).toBe(task.id);
    expect(await engine.humanTaskStore.listAll()).toHaveLength(1);
    const stored2 = await engine.humanTaskStore.getById(task.id);
    expect(stored2?.status).toBe("pending");
    expect(stored2?.meta?.["checkpointId"]).not.toBe(task.meta?.["checkpointId"]);
    expect(stored2?.meta?.["checkpointId"]).not.toBe("");
    // 真实 executor 下 ReAct 每轮状态转移都写 checkpoint（行数不固定），断言新 checkpoint 已落库。
    const saver = new SqliteCheckpointSaver(dbPath, sharedDb);
    const tuple = await saver.getTuple({ configurable: { thread_id: "ac2a-wf:ai" } });
    expect(tuple?.config.configurable?.checkpoint_id).toBe(stored2?.meta?.["checkpointId"]);

    const final = await engine.resume(task.id, { type: "approve" });
    expect(final.status).toBe("success");
    expect(final.nodeStates["ai"]).toBe("Success");
    expect(weatherCalls.count).toBe(1);
    expect(searchCalls.count).toBe(1);
    const toolCalls = final.nodeOutputs["ai"]?.["toolCalls"] as readonly { name: string }[];
    expect(toolCalls.map((t) => t.name)).toEqual(["demo.getWeather", "demo.search"]);
  });

  test("AC2b 循环中断：同一工具两次审批，两次 approve，工具执行两次", async () => {
    const dbPath = nextDbPath("ac2b");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    const wf = aiWorkflow("ac2b-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "循环查天气",
      tools: ["demo.getWeather"],
      interrupt: interruptConfig(["demo.getWeather"]),
    });
    const resumeModel = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [weatherCall, { kind: "text", text: "完成" }],
    });
    const engine = makeEngine(wf, sharedDb, {
      dbPath,
      runId: "ac2b-run",
      handler: makeResumeHandler({
        dbPath,
        sharedDb,
        model: resumeModel,
        tools: [makeWeatherTool(weatherCalls)],
        interrupt: interruptConfig(["demo.getWeather"]),
      }),
    });

    const task = expectWaiting(await engine.run());
    const round2 = await engine.resume(task.id, { type: "approve" });
    expect(round2.status).toBe("waiting");
    const final = await engine.resume(task.id, { type: "approve" });
    expect(final.status).toBe("success");
    expect(weatherCalls.count).toBe(2);
    const toolCalls = final.nodeOutputs["ai"]?.["toolCalls"] as readonly { name: string }[];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.name).toBe("demo.getWeather");
    expect(toolCalls[1]?.name).toBe("demo.getWeather");
  });
});

describe("AC1b reject 决策", () => {
  test("reject → agent 收到拒绝后文本收尾，工具实际未执行（副作用计数 0）", async () => {
    const dbPath = nextDbPath("ac1b");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    const wf = aiWorkflow("ac1b-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "上海天气？",
      tools: ["demo.getWeather"],
      interrupt: interruptConfig(["demo.getWeather"]),
    });
    const resumeModel = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "text", text: "用户不批准，跳过天气查询" }],
    });
    const engine = makeEngine(wf, sharedDb, {
      dbPath,
      runId: "ac1b-run",
      handler: makeResumeHandler({
        dbPath,
        sharedDb,
        model: resumeModel,
        tools: [makeWeatherTool(weatherCalls)],
        interrupt: interruptConfig(["demo.getWeather"]),
      }),
    });

    const task = expectWaiting(await engine.run());
    const resumed = await engine.resume(task.id, { type: "reject", message: "不批准" });
    expect(resumed.status).toBe("success");
    expect(resumed.nodeOutputs["ai"]?.["output"]).toBe("用户不批准，跳过天气查询");
    expect(weatherCalls.count).toBe(0); // reject 后工具不执行
  });
});

describe("AC3 事务一致性（e2e 级）", () => {
  test("中断后 checkpoint/humanTask/runState 三者同事务落库且一致", async () => {
    const dbPath = nextDbPath("ac3a");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    const wf = aiWorkflow("ac3a-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "上海天气？",
      tools: ["demo.getWeather"],
      interrupt: interruptConfig(["demo.getWeather"]),
    });
    const resumeModel = resolveModel({ provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "完成" }] });
    const engine = makeEngine(wf, sharedDb, {
      dbPath,
      runId: "ac3a-run",
      handler: makeResumeHandler({
        dbPath,
        sharedDb,
        model: resumeModel,
        tools: [makeWeatherTool(weatherCalls)],
        interrupt: interruptConfig(["demo.getWeather"]),
      }),
    });

    const task = expectWaiting(await engine.run());
    // checkpoint 行已落库：同 sharedDb 新建 saver 可读中断点。
    const saver = new SqliteCheckpointSaver(dbPath, sharedDb);
    const tuple = await saver.getTuple({ configurable: { thread_id: "ac3a-wf:ai" } });
    expect(tuple?.config.configurable?.checkpoint_id).toBe(task.meta?.["checkpointId"]);
    // humanTask 落库。
    const taskRow = sharedDb.db.prepare("SELECT status FROM human_tasks WHERE id = ?").get(task.id);
    expect((taskRow as { status: unknown }).status).toBe("pending");
    // runState waiting。
    const runRow = sharedDb.db.prepare("SELECT status FROM run_state WHERE run_id = ?").get("ac3a-run");
    expect((runRow as { status: unknown }).status).toBe("waiting");
  });

  test("runState 写入失败 → 整体回滚：humanTask/checkpoint 均不落库，节点 Failed", async () => {
    const dbPath = nextDbPath("ac3b");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    const wf = aiWorkflow("ac3b-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "上海天气？",
      tools: ["demo.getWeather"],
      interrupt: interruptConfig(["demo.getWeather"]),
    });
    const humanStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    const failingRunStore = new FailWaitingRunStore(new SqliteRunStateStore(dbPath, sharedDb));
    const engine = new ExecutionEngine(wf, {
      persist: true,
      runId: "ac3b-run",
      aiCheckpoint: { dbPath, sharedDb },
      humanTaskStore: humanStore,
      runStateStore: failingRunStore,
    });

    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["ai"]).toBe("Failed");
    expect(result.error).toContain("模拟 RunState 写入失败");
    expect(countCheckpoints(sharedDb, "ac3b-wf:ai")).toBe(0);
    expect(await humanStore.listAll()).toHaveLength(0);
  });
});

describe("AC4 恢复失败回退", () => {
  test("handler 首次失败 → 任务回退 pending、result 保留；再次 resume 成功", async () => {
    const dbPath = nextDbPath("ac4");
    const sharedDb = await openDatabase(dbPath);
    sharedDbs.push(sharedDb);
    sharedDb.ensureSchema();
    const weatherCalls: CallCount = { count: 0 };
    registerTool(makeWeatherTool(weatherCalls));
    const wf = aiWorkflow("ac4-wf", {
      model: { provider: "fake", model: "test", fakeScript: [weatherCall] },
      inputMessages: "上海天气？",
      tools: ["demo.getWeather"],
      interrupt: interruptConfig(["demo.getWeather"]),
    });
    const resumeModel = resolveModel({
      provider: "fake",
      model: "test",
      fakeScript: [{ kind: "text", text: "恢复成功" }],
    });
    const engine = makeEngine(wf, sharedDb, {
      dbPath,
      runId: "ac4-run",
      handler: makeResumeHandler({
        dbPath,
        sharedDb,
        model: resumeModel,
        tools: [makeWeatherTool(weatherCalls)],
        interrupt: interruptConfig(["demo.getWeather"]),
        failFirst: 1,
      }),
    });

    const task = expectWaiting(await engine.run());
    await expect(engine.resume(task.id, { type: "approve" })).rejects.toThrow("模拟 agent 恢复失败");
    // AC4：任务回退 pending，用户输入（result）保留。
    const stored = await engine.humanTaskStore.getById(task.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.result).toEqual({ type: "approve" });
    expect(stored?.completedAt).toBeUndefined();
    // 再次 resume：handler 第二次成功；不传 result 回退复用 task.result。
    const retried = await engine.resume(task.id);
    expect(retried.status).toBe("success");
    expect(retried.nodeOutputs["ai"]?.["output"]).toBe("恢复成功");
    expect(retried.nodeStates["end"]).toBe("Success");
  });
});

describe("AC5 统一运行时与回归", () => {
  test("llm 节点与 ai 节点共用同一 executor 实例（行为验证：单例 execute 计数）", async () => {
    const wf = buildWorkflow("ac5-wf", [
      { id: "start", type: "start" },
      { id: "ai", type: "ai", params: {
        model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "AI 回答" }] },
        inputMessages: "你好",
      } },
      { id: "llm", type: "llm", params: {
        model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "LLM 回答" }] },
        inputMessages: "继续",
      } },
      { id: "end", type: "end" },
    ], [
      { src: "start", srcPort: "data", dst: "ai", dstPort: "in" },
      { src: "ai", srcPort: "output", dst: "end", dstPort: "in" },
    ]);
    const original = aiExecutor.execute;
    let calls = 0;
    aiExecutor.execute = async (req) => {
      calls += 1;
      return original.call(aiExecutor, req);
    };
    try {
      const engine = new ExecutionEngine(wf);
      const result = await engine.run();
      expect(result.status).toBe("success");
      expect(result.nodeOutputs["ai"]?.["output"]).toBe("AI 回答");
      expect(result.nodeOutputs["llm"]?.["output"]).toBe("LLM 回答");
      expect(result.nodeStates["llm"]).toBe("Success");
    } finally {
      aiExecutor.execute = original;
    }
    // 两个节点都经同一单例执行器：若 llm 新建实例，spy 计数只到 1。
    expect(calls).toBe(2);
  });

  test("回归：无 interrupt 配置的 ai + llm 组合 workflow 正常执行", async () => {
    const wf = buildWorkflow("reg-wf", [
      { id: "start", type: "start" },
      { id: "ai", type: "ai", params: {
        model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "AI 文本" }] },
        inputMessages: "提问",
      } },
      { id: "llm", type: "llm", params: {
        model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "LLM 文本" }] },
        inputMessages: "追问",
      } },
      { id: "end", type: "end" },
    ], [
      { src: "start", srcPort: "data", dst: "ai", dstPort: "in" },
      { src: "ai", srcPort: "output", dst: "end", dstPort: "in" },
    ]);
    const engine = new ExecutionEngine(wf);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeStates["llm"]).toBe("Success");
    expect(result.nodeStates["end"]).toBe("Success");
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("AI 文本");
    expect(result.nodeOutputs["llm"]?.["output"]).toBe("LLM 文本");
  });
});
