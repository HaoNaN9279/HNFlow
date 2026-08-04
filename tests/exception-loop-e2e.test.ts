// T9 组合集成测试（v0.2.2 收官）：tryCatch + finally + loop 三层组合。
// 覆盖场景：
//   1. tryCatch 包裹 loop：loop 迭代中途失败（迭代 2）→ LoopFailedError → 外层 tryCatch 捕获 →
//      catch 分支执行、tryCatch Success；loop 部分迭代已执行（计数文件副作用 + 失败迭代号）
//   2. finally 在 loop 正常/失败后都执行：loop 正常完成 → finally 体标记生效；
//      loop 失败（无 tryCatch）→ finally 仍执行，最终 failed 保留主错误（进度/结果快照验证部分迭代）
//   3. 三层组合：tryCatch → loop → finally（父图链，loop 失败后 finally 清理）；
//      tryCatch(loop(finally 体))（loop body 内 finally 每迭代执行，失败迭代仍清理）
//   4. tryCatch + finally 与 AI 共存：tryCatch 捕获失败 + ai 节点（FakeLLM 纯文本）+ finally → 无中断、无回归
//   5. 错误传播链：loop body 内 subworkflow 失败 → loop Failed → tryCatch 捕获 → catch 链 → finally 清理 → success
// 说明：失败触发全部用内置节点（command 非零退出 / file 写文件），不注册自定义节点、不污染全局 registry。
//       "部分迭代后失败"通过计数脚本实现：command 每迭代自增计数文件，计数超过 failIndex 后非零退出。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunStateStoreLike } from "../src/db/stores/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import type { RunState } from "../src/runstate/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\exception-loop-e2e-test";

let fileCounter = 0;
function nextFilePath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.txt`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试（照 loop-recovery.test.ts）。 */
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

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeTryCatchNode(id: string, body: Workflow): Node {
  return {
    id,
    type: "tryCatch",
    name: "异常捕获",
    params: { body },
    inputs: [],
    outputs: [
      { id: "out", name: "结果", type: "any", direction: "out" },
      { id: "catch", name: "错误", type: "any", direction: "out" },
    ],
  };
}

function makeFinallyNode(id: string, body: Workflow): Node {
  return {
    id,
    type: "finally",
    name: "收尾清理",
    params: { body },
    inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

function makeLoopNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  const def = registry.get("loop");
  return { id, type: "loop", name: "循环", params, inputs: def.inputs, outputs: def.outputs };
}

/** 计数失败脚本：argv[1]=计数文件路径、argv[2]=failIndex。每次执行自增计数，计数 > failIndex 后 exit 1。 */
const COUNT_BOOM_SCRIPT =
  "const fs=require('fs');const p=process.argv[1];let c=0;try{c=Number(fs.readFileSync(p,'utf8'))}catch(e){}c+=1;fs.writeFileSync(p,String(c));process.exit(c>Number(process.argv[2])?1:0)";

/** 计数失败 body：每迭代 sv 写 endInput（结果收集）+ boom command（计数超过 failIndex 后失败）。
 *  countPath 文件值 = 已执行迭代数（部分迭代已执行的直接证据）。 */
function countBoomBody(countPath: string, failIndex: number): Workflow {
  return {
    id: "loop-body-count",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", {
        target: "workflow:endInput",
        value: "idx-${workflow:loopIndex}",
      }),
      makeNode("boom", "command", {
        command: "node",
        args: ["-e", COUNT_BOOM_SCRIPT, countPath, String(failIndex)],
        failOnNonZero: true,
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** loop body 内 finally 体：每迭代 finally 追加 finPath（含失败迭代，验证失败后清理链仍执行）。 */
function finallyInLoopBody(countPath: string, finPath: string, failIndex: number): Workflow {
  return {
    id: "loop-body-fin",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", {
        target: "workflow:endInput",
        value: "idx-${workflow:loopIndex}",
      }),
      makeNode("boom", "command", {
        command: "node",
        args: ["-e", COUNT_BOOM_SCRIPT, countPath, String(failIndex)],
        failOnNonZero: true,
      }),
      makeFinallyNode("fin", {
        id: "fin-body",
        name: "finbody",
        version: "0.1.0",
        nodes: [
          makeNode("start", "start"),
          makeNode("finCmd", "file", { operation: "write", path: finPath, content: "fin\n", append: true }),
          makeNode("end", "end"),
        ],
        edges: [],
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** 普通 loop body：setVariable 插值 loopIndex/loopItem → endInput，endResult 为组合字符串。 */
function interpolateBody(): Workflow {
  return {
    id: "loop-body-interp",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", {
        target: "workflow:endInput",
        value: "idx-${workflow:loopIndex}-item-${workflow:loopItem}",
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** loop body 内 subworkflow 失败：每迭代 sub 失败（迭代 0 即失败）。 */
function subFailBody(subgraph: Workflow): Workflow {
  return {
    id: "loop-body-sub",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sub", "subworkflow", { subworkflow: subgraph }),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "b1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** 失败子图：command 非零退出 → 子引擎 failed。 */
function failingSubgraph(id: string): Workflow {
  return {
    id,
    name: id,
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("cmd", "command", {
        command: "node",
        args: ["-e", "process.exit(1)"],
        failOnNonZero: true,
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** 失败 try 体：直接 command 非零退出。 */
function failingBody(): Workflow {
  return {
    id: "body-fail",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("cmd", "command", {
        command: "node",
        args: ["-e", "process.exit(1)"],
        failOnNonZero: true,
      }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** finally 体：setVariable 标记 → end，endResult 即清理标记（经 out 端口断言 finally 已执行）。 */
function cleanupBody(mark: string): Workflow {
  return {
    id: "body-clean",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeNode("sv", "setVariable", { target: "workflow:endInput", value: mark }),
      makeNode("end", "end"),
    ],
    edges: [],
  };
}

/** tryCatch body：start → loop → end，loop.results 透传 end。 */
function loopInTryBody(loopId: string, loopParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "body-try-loop",
    name: "body",
    version: "0.1.0",
    nodes: [
      makeNode("start", "start"),
      makeLoopNode(loopId, loopParams),
      makeNode("end", "end"),
    ],
    edges: [
      { id: "b1", sourceNodeId: loopId, sourcePortId: "results", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

/** catch 端口输出对象：message 必有，detail 可序列化时附带。 */
function asCatch(value: unknown): { message?: unknown; detail?: unknown } {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected catch 端口输出对象");
  }
  return value as { message?: unknown; detail?: unknown };
}

/** 读计数文件（已执行迭代数）。 */
async function readCount(path: string): Promise<number> {
  const content = await readFile(path, "utf8");
  return Number(content.trim());
}

/** 读 marker 文件统计指定 token 出现次数（证明 finally 每迭代执行）。 */
async function countMarker(path: string, token: string): Promise<number> {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter((line) => line === token).length;
}

/** 内存版 RunState store：持久化断言用（照 loop-node.test.ts）。 */
class FakeRunStateStore implements RunStateStoreLike {
  private readonly states = new Map<string, RunState>();

  async create(run: RunState): Promise<void> {
    this.states.set(run.runId, run);
  }

  async update(run: RunState): Promise<void> {
    this.states.set(run.runId, run);
  }

  async getById(runId: string): Promise<RunState | undefined> {
    return this.states.get(runId);
  }

  async list(): Promise<RunState[]> {
    return [...this.states.values()];
  }

  async listByWorkflow(workflowId: string): Promise<RunState[]> {
    return [...this.states.values()].filter((run) => run.workflowId === workflowId);
  }
}

/** 断言 RunState 快照存在并返回（undefined 视为测试失败）。 */
function expectSnap(snap: RunState | undefined): RunState {
  if (snap === undefined) {
    throw new Error("expected run state");
  }
  return snap;
}

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

describe("T9-1: tryCatch 包裹 loop（loop 失败进 catch）", () => {
  test("loop 迭代 2 失败 → LoopFailedError 被外层捕获、部分迭代已执行", async () => {
    const countPath = nextFilePath("s1");
    const parent: Workflow = {
      id: "t9-s1",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", loopInTryBody("loop", { items: 4, body: countBoomBody(countPath, 2) })),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "catch-branch" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    // catch 携带 LoopFailedError：失败发生在迭代 2（迭代 0、1 已成功执行）。
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("loop 迭代 2 执行失败");
    expect(caught.detail).toBeDefined();
    // catch 分支执行：错误被吞后流程继续。
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(engine.getWorkflowVariable("catchVal")).toBe("catch-branch");
    // 部分迭代已执行：计数文件 = 3（迭代 0、1、2 各执行一次 body，迭代 2 失败）。
    expect(await readCount(countPath)).toBe(3);
  });
});

describe("T9-2: finally 在 loop 正常/失败后都执行", () => {
  test("loop 正常完成 → 后续 finally 执行（body 标记生效）", async () => {
    const parent: Workflow = {
      id: "t9-s2-ok",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeLoopNode("loop", { items: [10, 20], body: interpolateBody() }),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "f", targetPortId: "in" },
        { id: "e2", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["loop"]).toBe("Success");
    expect(result.nodeOutputs["loop"]?.["results"]).toEqual(["idx-0-item-10", "idx-1-item-20"]);
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    expect(result.nodeStates["end"]).toBe("Success");
  });

  test("loop 失败（无 tryCatch）→ finally 仍执行、主错误保留、进度/结果快照证明部分迭代", async () => {
    const countPath = nextFilePath("s2-fail");
    const parent: Workflow = {
      id: "t9-s2-fail",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeLoopNode("loop", { items: 4, body: countBoomBody(countPath, 2) }),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "loop", sourcePortId: "results", targetNodeId: "f", targetPortId: "in" },
        { id: "e2", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const fake = new FakeRunStateStore();
    const engine = new ExecutionEngine(parent, {
      runId: "t9-s2-fail-1",
      persist: true,
      runStateStore: fake,
    });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["loop"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("loop 迭代 2 执行失败");
    // 失败后 finally 链继续：清理体标记生效。
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    // 部分迭代已执行（计数文件 = 3，迭代 0、1、2 各执行一次 body）。
    expect(await readCount(countPath)).toBe(3);
    // 断点快照：进度 = 失败迭代下标 2、已完成迭代（0、1）结果已收集。
    const snap = expectSnap(await fake.getById("t9-s2-fail-1"));
    expect(snap.contextSnapshot.node["node:loop"]?.["loopProgress"]).toBe(2);
    expect(snap.contextSnapshot.node["node:loop"]?.["loopResults"]).toEqual(["idx-0", "idx-1"]);
  });
});

describe("T9-3: 三层组合", () => {
  test("tryCatch → loop → finally：loop 失败被捕获、catch 链后 finally 清理、整体 success", async () => {
    const countPath = nextFilePath("s3a");
    const parent: Workflow = {
      id: "t9-s3a",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", loopInTryBody("loop", { items: 4, body: countBoomBody(countPath, 2) })),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "f", targetPortId: "in" },
        { id: "e2", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("loop 迭代 2 执行失败");
    // catch 链 → finally 清理执行。
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    expect(result.nodeStates["end"]).toBe("Success");
    expect(await readCount(countPath)).toBe(3);
  });

  test("tryCatch(loop(finally 体))：loop body 内 finally 每迭代执行，失败迭代仍清理", async () => {
    const countPath = nextFilePath("s3b");
    const finPath = nextFilePath("s3b-fin");
    const parent: Workflow = {
      id: "t9-s3b",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", loopInTryBody("loop", { items: 4, body: finallyInLoopBody(countPath, finPath, 2) })),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "caught" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("loop 迭代 2 执行失败");
    expect(result.nodeStates["catchSv"]).toBe("Success");
    // 三层语义：tryCatch 捕获 + loop 部分迭代（计数 = 3，迭代 0、1 成功）+ finally 每迭代清理（含失败迭代，共 3 次 fin）。
    expect(await readCount(countPath)).toBe(3);
    expect(await countMarker(finPath, "fin")).toBe(3);
  });
});

describe("T9-4: tryCatch + finally 与 AI 共存", () => {
  test("tryCatch 捕获失败 + ai 节点（FakeLLM 纯文本）+ finally：无中断、正常执行", async () => {
    const errors: Error[] = [];
    const parent: Workflow = {
      id: "t9-s4",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", failingBody()),
        makeNode("ai", "ai", {
          model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "AI 回答" }] },
          inputMessages: "你好",
        }),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "ai", targetPortId: "in" },
        { id: "e2", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "f", targetPortId: "in" },
        { id: "e3", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent, {
      events: { onError: (error) => errors.push(error) },
    }).run();
    expect(result.status).toBe("success"); // 未触发 AI 中断。
    expect(result.nodeStates["try"]).toBe("Success");
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("子工作流执行失败");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("AI 回答");
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    expect(result.nodeStates["end"]).toBe("Success");
    // tryCatch 吞错 → 父引擎 onError 不触发（无回归）。
    expect(errors).toHaveLength(0);
  });
});

describe("T9-5: 错误传播链", () => {
  test("loop body 内 subworkflow 失败 → loop Failed → tryCatch 捕获 → catch 链 → finally 清理 → success", async () => {
    const parent: Workflow = {
      id: "t9-s5",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeTryCatchNode("try", loopInTryBody("loop", { items: 3, body: subFailBody(failingSubgraph("sub-graph")) })),
        makeNode("catchSv", "setVariable", { target: "workflow:catchVal", value: "caught" }),
        makeFinallyNode("f", cleanupBody("cleaned-up")),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "try", sourcePortId: "catch", targetNodeId: "catchSv", targetPortId: "in" },
        { id: "e2", sourceNodeId: "catchSv", sourcePortId: "out", targetNodeId: "f", targetPortId: "in" },
        { id: "e3", sourceNodeId: "f", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["try"]).toBe("Success");
    // 错误链：subworkflow 失败 → LoopFailedError（迭代 0）→ 外层 catch 兜住。
    const caught = asCatch(result.nodeOutputs["try"]?.["catch"]);
    expect(String(caught.message)).toContain("loop 迭代 0 执行失败");
    expect(String(caught.message)).toContain("子工作流执行失败");
    // catch 链 → finally 清理 → 整体 success（catch 兜住）。
    expect(result.nodeStates["catchSv"]).toBe("Success");
    expect(result.nodeStates["f"]).toBe("Success");
    expect(result.nodeOutputs["f"]?.["out"]).toBe("cleaned-up");
    expect(result.nodeStates["end"]).toBe("Success");
  });
});
