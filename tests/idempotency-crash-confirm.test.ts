// 崩溃转人工确认 e2e（v0.2.5 T4）：幂等键开启时非幂等节点 Failed → crash_confirm humanTask → WaitingForHuman；
// confirm→resume、skip→skip；纯函数/无 key 直接 Failed；findPending 带 runId 查重；finally/tryCatch 语义。
// 自定义节点（boom/pureBoom/cleanCounter）注册在独立 NodeRegistry，不污染全局 registry。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { INodeDefinition } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";
const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\idempotency-crash-confirm-test";
let fileCounter = 0;
const nextStorePath = () => join(TEMP_BASE, `cc-${Date.now()}-${fileCounter++}.json`);
beforeAll(async () => { await mkdir(TEMP_BASE, { recursive: true }); });
afterAll(async () => { await rmRetry(TEMP_BASE); }, 30000);
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) { Bun.gc(true); await new Promise((r) => setTimeout(r, 200)); continue; }
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
const PORT = (id: string, direction: "in" | "out") => ({ id, name: id, type: "any" as const, direction });
function boomDef(state: { runs: number; fail: boolean }): INodeDefinition { // 非幂等失败节点：fail=true 抛错（崩溃转人工触发）
  return {
    type: "boom", name: "boom", idempotent: false, inputs: [PORT("in", "in")], outputs: [PORT("out", "out")],
    async execute() { state.runs++; if (state.fail) throw new Error("boom exploded"); return { out: "recovered" }; },
  };
}
function pureDef(): INodeDefinition { // 纯函数失败节点（idempotent=true）：不应转人工
  return {
    type: "pureBoom", name: "pureBoom", idempotent: true, inputs: [PORT("in", "in")], outputs: [PORT("out", "out")],
    async execute() { throw new Error("pure failed"); },
  };
}
function cleanDef(state: { runs: number }): INodeDefinition { // 清理计数节点（finally body 用）
  return {
    type: "cleanCounter", name: "clean", idempotent: true, inputs: [], outputs: [],
    async execute() { state.runs++; return {}; },
  };
}
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
}
function makeNode(id: string, type: string, reg: NodeRegistry, params: Record<string, unknown> = {}): Node {
  const def = reg.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}
function linearWf(id: string, reg: NodeRegistry, fail: Node): Workflow { // start → failNode → end
  return { id, name: id, version: "0.1.0",
    nodes: [makeNode("start", "start", reg), fail, makeNode("end", "end", reg)],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: fail.id, targetPortId: "in" },
      { id: "e2", sourceNodeId: fail.id, sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }] };
}
function humanWf(id: string, reg: NodeRegistry): Workflow { // start → humanTask → end（既有挂起语义回归）
  return { id, name: id, version: "0.1.0",
    nodes: [makeNode("start", "start", reg), makeNode("human", "humanTask", reg, { title: "审批" }), makeNode("end", "end", reg)],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "human", targetPortId: "in" },
      { id: "e2", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" }] };
}
function finallyWf(id: string, reg: NodeRegistry, fail: Node): Workflow { // start → failNode → finally(clean)
  const body: Workflow = { id: "body-clean", name: "body", version: "0.1.0", nodes: [makeNode("start", "start", reg), makeNode("clean", "cleanCounter", reg), makeNode("end", "end", reg)], edges: [] };
  const fin: Node = { id: "fin", type: "finally", name: "收尾清理", params: { body }, inputs: [], outputs: [PORT("out", "out")] };
  return { id, name: id, version: "0.1.0",
    nodes: [makeNode("start", "start", reg), fail, fin],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: fail.id, targetPortId: "in" },
      { id: "e2", sourceNodeId: fail.id, sourcePortId: "out", targetNodeId: "fin", targetPortId: "in" }] };
}
function tryCatchWf(id: string, reg: NodeRegistry, bodyFail: Node): Workflow { // start → tryCatch(body: start → failNode → end) → end
  const body: Workflow = { id: "try-body", name: "body", version: "0.1.0", nodes: [makeNode("start", "start", reg), bodyFail, makeNode("end", "end", reg)],
    edges: [
      { id: "b1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: bodyFail.id, targetPortId: "in" },
      { id: "b2", sourceNodeId: bodyFail.id, sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }] };
  const tr: Node = { id: "try", type: "tryCatch", name: "异常捕获", params: { body }, inputs: [], outputs: [PORT("out", "out"), PORT("catch", "out")] };
  return { id, name: id, version: "0.1.0",
    nodes: [makeNode("start", "start", reg), tr, makeNode("end", "end", reg)],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "try", targetPortId: "in" },
      { id: "e2", sourceNodeId: "try", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }] };
}
function expectWaiting(r: { status: string; waitingTask?: HumanTask }): HumanTask {
  const task = r.waitingTask;
  if (r.status !== "waiting" || task === undefined) throw new Error(`expected waiting, got: ${r.status}`);
  return task;
}
describe("崩溃转人工确认：决策路径", () => {
  test("confirm → resume 重跑失败节点成功", async () => {
    const st = { runs: 0, fail: true };
    const reg = makeRegistry([boomDef(st)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(linearWf("cc-1", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, idempotencyKey: "req-1",
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("waiting");
    const task = expectWaiting(r1);
    expect(task.meta?.["kind"]).toBe("crash_confirm");
    expect(task.runId).toBe(engine.runId);
    expect(r1.nodeStates["boom"]).toBe("WaitingForHuman");
    expect(await store.listPending()).toHaveLength(1);
    st.fail = false;
    const r2 = await engine.resume(task.id, "retry");
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["boom"]).toBe("Success");
    expect(st.runs).toBe(2); // 崩溃 1 次 + 重跑成功 1 次
    expect(await store.listPending()).toHaveLength(0);
  });
  test("skip → 节点 Skipped、下游 Skipped、run success", async () => {
    const st = { runs: 0, fail: true };
    const reg = makeRegistry([boomDef(st)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(linearWf("cc-2", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, idempotencyKey: "req-2",
    });
    const task = expectWaiting(await engine.run());
    const r2 = await engine.skip(task.id);
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["boom"]).toBe("Skipped");
    expect(r2.nodeStates["end"]).toBe("Skipped"); // 上游 Skipped → 下游不激活
    expect((await store.getById(task.id))?.status).toBe("skipped");
  });
  test("纯函数节点（idempotent=true）失败 → 直接 failed 不转人工", async () => {
    const reg = makeRegistry([pureDef()]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(linearWf("cc-3", reg, makeNode("pure", "pureBoom", reg)), {
      registry: reg, humanTaskStore: store, idempotencyKey: "req-3",
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("failed");
    expect(r1.nodeStates["pure"]).toBe("Failed");
    expect(await store.listPending()).toHaveLength(0);
  });
  test("无 idempotencyKey：非幂等节点失败 → 直接 failed（现状回归）", async () => {
    const st = { runs: 0, fail: true };
    const reg = makeRegistry([boomDef(st)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(linearWf("cc-4", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store,
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("failed");
    expect(r1.nodeStates["boom"]).toBe("Failed");
    expect(await store.listPending()).toHaveLength(0);
  });
});
describe("findPending 带 runId 精确查重", () => {
  test("跨 run 同节点不串任务：run2 创建自己的 crash_confirm", async () => {
    const st = { runs: 0, fail: true };
    const reg = makeRegistry([boomDef(st)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const e1 = new ExecutionEngine(linearWf("cc-5", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, runId: "cc-run-1", idempotencyKey: "req-5a",
    });
    const t1 = expectWaiting(await e1.run());
    const e2 = new ExecutionEngine(linearWf("cc-5", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, runId: "cc-run-2", idempotencyKey: "req-5b",
    });
    const t2 = expectWaiting(await e2.run());
    expect(t2.id).not.toBe(t1.id);
    expect(await store.listPending()).toHaveLength(2);
    expect((await store.findPending("cc-5", "boom", "cc-run-1"))?.id).toBe(t1.id);
    expect((await store.findPending("cc-5", "boom", "cc-run-2"))?.id).toBe(t2.id);
    expect(await store.findPending("cc-5", "boom")).toBeDefined(); // 不带 runId 旧语义仍命中
  });
  test("同 run 重复执行：findPending(runId) 复用不重复创建", async () => {
    const st = { runs: 0, fail: true };
    const reg = makeRegistry([boomDef(st)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(linearWf("cc-6", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, runId: "cc-run-6", idempotencyKey: "req-6",
    });
    const t1 = expectWaiting(await engine.run());
    const r2 = await engine.run(); // 同引擎同 runId：节点再崩溃 → 复用 t1
    expect(r2.status).toBe("waiting");
    expect(r2.waitingTask?.id).toBe(t1.id);
    expect(await store.listPending()).toHaveLength(1);
  });
  test("humanTask 挂起回归：任务带 runId、resume 恢复、不误判 ai_interrupt", async () => {
    const reg = makeRegistry([]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(humanWf("cc-7", reg), {
      registry: reg, humanTaskStore: store, runId: "cc-run-7", idempotencyKey: "req-7",
    });
    const task = expectWaiting(await engine.run());
    expect(task.runId).toBe("cc-run-7");
    expect(task.meta?.["kind"]).toBeUndefined();
    expect((await engine.resume(task.id, "ok")).status).toBe("success");
  });
});
describe("容器场景语义", () => {
  test("finally：崩溃转人工 waiting 时 finally 不放行，resume 成功后 finally 执行", async () => {
    const boom = { runs: 0, fail: true };
    const clean = { runs: 0 };
    const reg = makeRegistry([boomDef(boom), cleanDef(clean)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(finallyWf("cc-8", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, idempotencyKey: "req-8",
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("waiting");
    expect(clean.runs).toBe(0); // waiting 时 finally（上游 WaitingForHuman）不放行
    const task = expectWaiting(r1);
    boom.fail = false;
    const r2 = await engine.resume(task.id, "ok");
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["fin"]).toBe("Success");
    expect(clean.runs).toBe(1); // resume 后 boom Success → finally 正常执行
  });
  test("tryCatch：body 内非幂等节点崩溃 → 透传 waiting（不吞）→ resume 重跑成功", async () => {
    const boom = { runs: 0, fail: true };
    const reg = makeRegistry([boomDef(boom)]);
    const store = new HumanTaskStore({ filePath: nextStorePath() });
    const engine = new ExecutionEngine(tryCatchWf("cc-9", reg, makeNode("boom", "boom", reg)), {
      registry: reg, humanTaskStore: store, idempotencyKey: "req-9",
    });
    const r1 = await engine.run();
    expect(r1.status).toBe("waiting");
    const task = expectWaiting(r1);
    expect(task.workflowId).toBe("cc-9:try"); // 子图路径标识
    expect(task.nodeId).toBe("boom");
    expect(task.meta?.["kind"]).toBe("crash_confirm");
    boom.fail = false;
    const r2 = await engine.resume(task.id, "ok");
    expect(r2.status).toBe("success");
    expect(r2.nodeStates["try"]).toBe("Success");
    expect(r2.nodeOutputs["try"]?.["out"]).toBe("recovered");
  });
});
// parallel 语义记录（未单独测）：分支子引擎继承 runId + 幂等键（subgraph-exec 透传），分支内崩溃转人工 →
// runBranch 抛 SubworkflowWaitingError → parallel 合并已完成分支后透传第一个 waiting；resume 后读
// doneBranches 跳过已完成分支、崩溃分支重跑（与挂起恢复同构，见 parallel-recovery.test.ts）。
