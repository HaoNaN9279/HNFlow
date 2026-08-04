// 组合集成测试（v0.2.3 AC4）：parallel 与 tryCatch/finally/挂起/AI 协同。
// 1. tryCatch 包 parallel（分支失败进 catch） 2. finally 在 parallel 失败后执行
// 3. parallel 内 tryCatch 吞错 4. humanTask 挂起→resume 5. AI 节点共存
// 6. 三层组合 tryCatch(parallel(loop)) 7. 挂起+失败共存（失败优先）
// 失败触发全部用内置节点（command 非零退出）；独立 NodeRegistry 实例，engine 构造显式注入。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";
import type { HumanTask } from "../src/human/types.js";
import type { Edge, Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\exception-parallel-e2e-test";
const REG = createRegistry(); // 独立 registry：全部内置节点，不污染全局 registry。
let fileCounter = 0;
function nextFilePath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.json`);
}
function createRegistry(): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  return reg;
}
function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = REG.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}
function makeTryCatchNode(id: string, body: Workflow): Node {
  return {
    id, type: "tryCatch", name: "异常捕获", params: { body }, inputs: [],
    outputs: [
      { id: "out", name: "结果", type: "any", direction: "out" },
      { id: "catch", name: "错误", type: "any", direction: "out" },
    ],
  };
}
function makeFinallyNode(id: string, body: Workflow): Node {
  return {
    id, type: "finally", name: "收尾清理", params: { body }, inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}
function makeParallelNode(id: string, branches: readonly unknown[]): Node {
  const def = REG.get("parallel");
  return { id, type: "parallel", name: "并行分支", params: { branches }, inputs: def.inputs, outputs: def.outputs };
}
function makeLoopNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = REG.get("loop");
  return { id, type: "loop", name: "循环", params, inputs: def.inputs, outputs: def.outputs };
}
/** 通用 body：start + 中间节点 + end，endResult 经 endInput/edges 决定。 */
function bodyWorkflow(id: string, name: string, middle: readonly Node[], edges: readonly Edge[] = []): Workflow {
  return {
    id, name, version: "0.1.0",
    nodes: [makeNode("start", "start"), ...middle, makeNode("end", "end")],
    edges,
  };
}
function endInputBody(id: string, name: string, endInput: unknown): Workflow {
  return bodyWorkflow(id, name, [makeNode("sv", "setVariable", { target: "workflow:endInput", value: endInput })]);
}
function failingWorkflow(id: string): Workflow {
  return bodyWorkflow(id, id, [
    makeNode("cmd", "command", { command: "node", args: ["-e", "process.exit(1)"], failOnNonZero: true }),
  ]);
}
function waitingBranch(): Workflow {
  return bodyWorkflow("wait-b", "b2", [makeNode("human", "humanTask", { title: "并行分支审批" })], [
    { id: "x1", sourceNodeId: "human", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
  ]);
}
/** start → parallel → end：父图或 tryCatch body 共用（仅 id/name 不同）。 */
function parWorkflow(id: string, name: string, branches: readonly unknown[]): Workflow {
  return {
    id, name, version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeParallelNode("par", branches),
      makeNode("end", "end"),
    ],
    edges: [{ id: "x1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" }],
  };
}
function parParent(id: string, branches: readonly unknown[]): Workflow {
  return parWorkflow(id, "parent", branches);
}
function parallelBody(branches: readonly unknown[]): Workflow {
  return parWorkflow("try-body", "body", branches);
}
/** 父图：start → tryCatch(parallelBody) → catchSv → end。 */
function tryParallelParent(id: string, branches: readonly unknown[], catchVal: string): Workflow {
  return {
    id, name: "parent", version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeTryCatchNode("try", parallelBody(branches)),
      makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: catchVal }),
      makeNode("end", "end"),
    ],
    edges: [{ id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" }],
  };
}
function asCatch(value: unknown): { message?: unknown; detail?: unknown } {
  if (typeof value !== "object" || value === null) throw new Error("expected catch 端口输出对象");
  return value as { message?: unknown; detail?: unknown };
}
function expectWaiting(result: { status: string; waitingTask?: HumanTask }): HumanTask {
  if (result.status !== "waiting") throw new Error(`expected waiting status, got: ${result.status}`);
  const task = result.waitingTask;
  if (task === undefined) throw new Error("expected waitingTask in result");
  return task;
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
}, 30000);

describe("exception-parallel-e2e: parallel × tryCatch/finally/挂起/AI（v0.2.3 AC4）", () => {
  test("T5-1 tryCatch 包 parallel：分支失败进 catch、流程继续", async () => {
    const parent = tryParallelParent("t5-s1", [
      { id: "b1", workflow: endInputBody("branch-b1", "b1", "B1") },
      { id: "b2", workflow: failingWorkflow("b2") },
    ], "catch-branch");
    const engine = new ExecutionEngine(parent, { registry: REG });
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    expect(String(asCatch(result.nodeOutputs["try"]?.["catch"]).message)).toContain("parallel 分支 b2 执行失败");
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("catchVal")).toBe("catch-branch");
  });

  test("T5-2 finally 在 parallel 失败后执行：清理体生效、主错误保留", async () => {
    const parent: Workflow = {
      id: "t5-s2", name: "parent", version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeParallelNode("par", [
          { id: "b1", workflow: endInputBody("branch-b1", "b1", "B1") },
          { id: "b2", workflow: failingWorkflow("b2") },
        ]),
        makeFinallyNode("f", endInputBody("body-clean", "body", "cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "par", sourcePortId: "results", targetNodeId: "f", targetPortId: "in" },
        { id: "e2", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent, { registry: REG }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["par"]).toBe("Failed");
    expect(result.error ?? "").toContain("parallel 分支 b2 执行失败");
    // 失败后 finally 链继续：清理体标记生效，主错误保留。
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
  });

  test("T5-3 parallel 内 tryCatch：分支吞掉子图失败、容器不失败", async () => {
    const caughtBranch = bodyWorkflow("b1-catch", "b1", [makeTryCatchNode("try", failingWorkflow("inner"))], [
      { id: "x1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "end", targetPortId: "in" },
    ]);
    const parent = parParent("t5-s3", [
      { id: "b1", workflow: caughtBranch },
      { id: "b2", workflow: endInputBody("branch-b2", "b2", "B2") },
    ]);
    const result = await new ExecutionEngine(parent, { registry: REG }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["par"]).toBe("Success");
    const results = result.nodeOutputs["par"]?.["results"] as { b1: unknown; b2: unknown };
    // catch 值经 end.in 入 endResult：分支内 tryCatch 捕获成功、分支正常完成。
    expect(String(asCatch(results.b1).message)).toContain("子工作流执行失败");
    expect(results.b2).toBe("B2");
  });

  test("T5-4 parallel 内 humanTask 挂起：waiting → resume → 完成", async () => {
    const parent = parParent("t5-s4", [
      { id: "b1", workflow: endInputBody("branch-b1", "b1", "B1") },
      { id: "b2", workflow: waitingBranch() },
    ]);
    const store = new HumanTaskStore({ filePath: nextFilePath("store4") });
    const engine = new ExecutionEngine(parent, { registry: REG, humanTaskStore: store });
    const result = await engine.run();
    const task = expectWaiting(result);
    expect(task.nodeId).toBe("human");
    expect(task.workflowId).toBe("t5-s4:par:b2");
    const resumed = await engine.resume(task.id, "approve");
    expect(resumed.status).toBe("success");
    // b1 已完成（doneBranches）跳过不重复合并，b2 读 task_result 完成。
    expect(resumed.nodeOutputs["par"]?.["results"]).toEqual({ b2: "approve" });
  });

  test("T5-5 parallel 内 AI 节点共存：FakeLLM 纯文本执行成功、结果合并", async () => {
    const aiBranch = bodyWorkflow("ai-b1", "b1", [makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "AI 回答" }] },
      inputMessages: "你好",
    })], [
      { id: "x1", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ]);
    const parent = parParent("t5-s5", [
      { id: "b1", workflow: aiBranch },
      { id: "b2", workflow: endInputBody("branch-b2", "b2", "B2") },
    ]);
    const result = await new ExecutionEngine(parent, { registry: REG }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["par"]).toBe("Success");
    // ai 输出经 end.in 入 endResult：results.b1 证明分支内 ai 执行成功。
    expect(result.nodeOutputs["par"]?.["results"]).toEqual({ b1: "AI 回答", b2: "B2" });
  });

  test("T5-6 三层组合 tryCatch(parallel(loop))：错误传播链完整", async () => {
    const loopBranch = bodyWorkflow("b2-loop", "b2", [makeLoopNode("loop", { items: 2, body: failingWorkflow("lb") })], [
      { id: "x1", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
    ]);
    const parent = tryParallelParent("t5-s6", [
      { id: "b1", workflow: endInputBody("branch-b1", "b1", "B1") },
      { id: "b2", workflow: loopBranch },
    ], "caught");
    const engine = new ExecutionEngine(parent, { registry: REG });
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    // 错误链：loop 迭代失败 → 分支子引擎 failed → ParallelBranchFailedError → tryCatch 捕获。
    expect(String(caught.message)).toContain("parallel 分支 b2 执行失败");
    expect(String(caught.message)).toContain("loop 迭代 0 执行失败");
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("catchVal")).toBe("caught");
  });

  test("T5-7 挂起+失败共存：失败优先抛 ParallelBranchFailedError", async () => {
    const parent = parParent("t5-s7", [
      { id: "b1", workflow: waitingBranch() },
      { id: "b2", workflow: failingWorkflow("b2") },
    ]);
    const store = new HumanTaskStore({ filePath: nextFilePath("store7") });
    const engine = new ExecutionEngine(parent, { registry: REG, humanTaskStore: store });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["par"]).toBe("Failed");
    // 失败优先：b1 已挂起（humanTask 已创建）仍被失败覆盖。
    expect(result.error ?? "").toContain("parallel 分支 b2 执行失败");
    expect(await store.listPending()).toHaveLength(1);
  });
});
