// T5 异常恢复测试：扫描/决策/中文提示纯函数 + 恢复端到端（临时 store：running 残留 → 重建引擎续跑剩余节点 → 终态写回）。
// 运行方式：仓库根 `bun test apps/desktop/src/__tests__/recovery.test.ts`。
import { afterAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../../../../src/execution/Engine.js";
import { buildEngineFromRunState, continueRun } from "../../../../src/execution/resume.js";
import type { RunStateStoreLike } from "../../../../src/db/stores/types.js";
import type { INodeDefinition, NodeExecutionContext } from "../../../../src/execution/types.js";
import type { Node, Workflow } from "../../../../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../../../../src/nodes/registry.js";
import { RunStateStore } from "../../../../src/runstate/RunStateStore.js";
import type { RunState } from "../../../../src/runstate/types.js";
import { decideRecovery, recoverInterruptedRuns, recoveryMessage, scanRecoverableRuns } from "../recovery.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

/** 最小合法 workflow（纯函数测试构造 RunState 用）。 */
const emptyWorkflow: Workflow = { id: "wf", name: "wf", version: "0.1.0", nodes: [], edges: [] };

/** 便捷构造 workflow 节点（port 形状与 workflowSchema 对齐）。 */
function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** 计数命令节点：每次 execute 递增（断言"恢复不重跑已 Success 节点"）。 */
function countCmdNode(id: string): Node {
  return {
    id,
    type: "countCmd",
    name: id,
    params: {},
    inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
  };
}
function countCmdDef(state: { runs: number }): INodeDefinition {
  return {
    type: "countCmd",
    name: "countCmd",
    inputs: [],
    outputs: [{ id: "count", name: "count", type: "number", direction: "out" }],
    async execute(_ctx: NodeExecutionContext) {
      state.runs++;
      return { count: state.runs };
    },
  };
}

/** 基于内置节点 + 自定义定义构建独立 registry（闭包计数器隔离）。 */
function makeRegistry(defs: readonly INodeDefinition[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const def of builtinNodes) reg.register(def);
  for (const def of defs) reg.register(def);
  return reg;
}

/** 构造最小可用的 RunState（status 由调用方指定）。 */
function runState(id: string, status: RunState["status"]): RunState {
  return {
    runId: id,
    workflowId: "wf",
    workflow: emptyWorkflow,
    nodeStates: {},
    nodeOutputs: {},
    contextSnapshot: { global: {}, workflow: {}, node: {} },
    status,
    updatedAt: 1000,
  };
}

const storePaths: string[] = [];
let fileCounter = 0;
function nextStorePath(): string {
  const path = join(TEMP_BASE, `hnflow-recovery-${Date.now()}-${fileCounter++}.json`);
  storePaths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(storePaths.map((path) => rm(path, { force: true })));
});

describe("scanRecoverableRuns", () => {
  it("仅过滤 status=running；success/failed/waiting/paused 排除", () => {
    const runs = [
      runState("r-running", "running"),
      runState("r-success", "success"),
      runState("r-failed", "failed"),
      runState("r-waiting", "waiting"),
      runState("r-paused", "paused"),
    ];
    expect(scanRecoverableRuns(runs).map((run) => run.runId)).toEqual(["r-running"]);
  });

  it("空数组 → 无可恢复", () => {
    expect(scanRecoverableRuns([])).toEqual([]);
  });
});

describe("decideRecovery", () => {
  it("有 running run + autoRecover=true → 恢复且带中文提示", () => {
    const decision = decideRecovery([runState("r1", "running"), runState("r2", "success")], { autoRecover: true });
    expect(decision.recover).toBe(true);
    expect(decision.message).toBe(recoveryMessage(1));
  });

  it("有 running run 缺省 autoRecover → 提示但不自动恢复", () => {
    const decision = decideRecovery([runState("r1", "running")]);
    expect(decision.recover).toBe(false);
    expect(decision.message).toBe(recoveryMessage(1));
  });

  it("无可恢复 run → 不恢复且无提示", () => {
    expect(decideRecovery([])).toEqual({ recover: false });
    expect(decideRecovery([runState("r1", "success"), runState("r2", "failed")])).toEqual({ recover: false });
  });
});

describe("recoveryMessage", () => {
  it("中文提示包含数量", () => {
    expect(recoveryMessage(2)).toBe("检测到 2 个未完成的工作流，正在恢复…");
    expect(recoveryMessage(1)).toBe("检测到 1 个未完成的工作流，正在恢复…");
  });
});

describe("恢复端到端（临时 store）", () => {
  /** 构造 recovery-e2e 场景：正常跑完取真实快照 → 模拟异常退出残留（快照改中间态 + status 保持 running）。 */
  async function setupInterruptedRun(): Promise<{ readonly store: RunStateStore; readonly cmdState: { runs: number } }> {
    const cmdState = { runs: 0 };
    const reg = makeRegistry([countCmdDef(cmdState)]);
    const workflow: Workflow = {
      id: "recovery-e2e-wf",
      name: "recovery-e2e",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("svA", "setVariable", { target: "workflow:x", value: 1 }),
        countCmdNode("cmd"),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "svA", targetPortId: "in" },
        { id: "e2", sourceNodeId: "svA", sourcePortId: "out", targetNodeId: "cmd", targetPortId: "in" },
        { id: "e3", sourceNodeId: "cmd", sourcePortId: "count", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextStorePath() });
    const engine1 = new ExecutionEngine(workflow, {
      registry: reg,
      runId: "recovery-e2e",
      persist: true,
      runStateStore: store,
    });
    const r1 = await engine1.run();
    expect(r1.status).toBe("success");
    const snap = await store.getById("recovery-e2e");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    return { store, cmdState };
  }

  it("中断在 cmd 后 → 恢复只跑 end，不重跑已 Success 节点，终态写回不再残留", async () => {
    const { store, cmdState } = await setupInterruptedRun();
    const snap = await store.getById("recovery-e2e");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    // 模拟异常退出残留：cmd 已 Success、end 未执行（中断点在 cmd 后），status 仍 running（未写 success）。
    const interrupted: RunState = {
      ...snap,
      nodeStates: { start: "Success", svA: "Success", cmd: "Success", end: "Idle" },
      status: "running",
    };
    await store.update(interrupted);
    // 启动扫描：识别该 run 并决策自动恢复。
    const recoverable = scanRecoverableRuns(await store.list());
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.runId).toBe("recovery-e2e");
    expect(decideRecovery(recoverable, { autoRecover: true }).recover).toBe(true);
    // 恢复执行：重建引擎从断点续跑，只跑剩余节点（end），不重跑 start/svA/cmd。
    for (const run of recoverable) {
      const engine = buildEngineFromRunState(run, { registry: registryForRecovery(cmdState), persist: true, runStateStore: store });
      const result = await continueRun(engine, run);
      expect(result.status).toBe("success");
    }
    expect(cmdState.runs).toBe(1); // cmd 未重跑（中断在 cmd 后）
    expect((await store.getById("recovery-e2e"))?.nodeStates["cmd"]).toBe("Success");
    expect((await store.getById("recovery-e2e"))?.nodeStates["end"]).toBe("Success");
    // 终态写回 success：下次启动不再识别为可恢复。
    expect((await store.getById("recovery-e2e"))?.status).toBe("success");
    expect(scanRecoverableRuns(await store.list())).toHaveLength(0);
  });

  it("中断在 cmd 前 → 恢复重跑未完成节点（cmd/end），start/svA 不重跑", async () => {
    const { store, cmdState } = await setupInterruptedRun();
    const snap = await store.getById("recovery-e2e");
    if (snap === undefined) {
      throw new Error("expected run state");
    }
    // 模拟异常退出残留：svA 已执行、cmd 未执行（中断点在 cmd 前），status 仍 running。
    const interrupted: RunState = {
      ...snap,
      nodeStates: { start: "Success", svA: "Success", cmd: "Idle", end: "Idle" },
      status: "running",
    };
    await store.update(interrupted);
    const recoverable = scanRecoverableRuns(await store.list());
    expect(recoverable).toHaveLength(1);
    // 恢复执行：重建引擎从断点续跑，重跑 cmd/end。
    for (const run of recoverable) {
      const engine = buildEngineFromRunState(run, { registry: registryForRecovery(cmdState), persist: true, runStateStore: store });
      const result = await continueRun(engine, run);
      expect(result.status).toBe("success");
    }
    expect(cmdState.runs).toBe(2); // 首次运行跑 1 次 + 恢复重跑 1 次（cmd 是未完成节点）
    expect((await store.getById("recovery-e2e"))?.nodeStates["cmd"]).toBe("Success");
    expect((await store.getById("recovery-e2e"))?.nodeStates["end"]).toBe("Success");
    expect((await store.getById("recovery-e2e"))?.status).toBe("success");
    expect(scanRecoverableRuns(await store.list())).toHaveLength(0);
  });

  /** 恢复用 registry：与 setup 相同（闭包计数器共享，可断言重跑次数）。 */
  function registryForRecovery(cmdState: { runs: number }): NodeRegistry {
    return makeRegistry([countCmdDef(cmdState)]);
  }
});

describe("recoverInterruptedRuns 端到端（临时 store）", () => {
  it("running 残留 → 自动恢复完成剩余节点 → 终态写回不再残留", async () => {
    // 用内置节点构造（recoverInterruptedRuns 走默认 registry，不注入自定义节点）。
    const workflow: Workflow = {
      id: "recovery-fn-e2e-wf",
      name: "recovery-fn-e2e",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("svA", "setVariable", { target: "workflow:x", value: 1 }),
        makeNode("log", "log", { message: "hello", level: "info" }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "svA", targetPortId: "in" },
        { id: "e2", sourceNodeId: "svA", sourcePortId: "out", targetNodeId: "log", targetPortId: "in" },
        { id: "e3", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const store = new RunStateStore({ filePath: nextStorePath() });
    // 手工构造异常退出残留：svA 已执行、log/end 未执行，status 仍 running（未写 success）。
    const interrupted: RunState = {
      runId: "recovery-fn-e2e",
      workflowId: workflow.id,
      workflow,
      nodeStates: { start: "Success", svA: "Success", log: "Idle", end: "Idle" },
      nodeOutputs: {},
      contextSnapshot: { global: {}, workflow: { x: 1 }, node: {} },
      status: "running",
      updatedAt: 1000,
    };
    await store.create(interrupted);
    // 启动自动恢复（注入 store + 根目录，等价 main.ts 接线）。
    await recoverInterruptedRuns(store, { templatesRootDir: TEMP_BASE, groupsRootDir: TEMP_BASE });
    // 恢复成功：剩余节点执行完，终态写回 success，下次不再识别。
    const after = await store.getById("recovery-fn-e2e");
    expect(after?.nodeStates["log"]).toBe("Success");
    expect(after?.nodeStates["end"]).toBe("Success");
    expect(after?.status).toBe("success");
    expect(scanRecoverableRuns(await store.list())).toHaveLength(0);
  });

  it("无可恢复 run → 静默返回（store 不变）", async () => {
    const store = new RunStateStore({ filePath: nextStorePath() });
    await store.create(runState("done", "success"));
    await recoverInterruptedRuns(store, { templatesRootDir: TEMP_BASE, groupsRootDir: TEMP_BASE });
    expect(await store.list()).toHaveLength(1); // 无新增/无删除
    expect((await store.getById("done"))?.status).toBe("success");
  });
});

/**
 * 恢复失败路径 stub store：恢复执行期落盘（persistRunState → update(running)）抛错，模拟持久化异常；
 * 仅 status="failed" 的 update 放行并记录（recoverInterruptedRuns catch 内标记用），并回写内部列表。
 */
class ThrowingPersistStore implements RunStateStoreLike {
  private runs: readonly RunState[];
  readonly failedUpdates: RunState[] = [];

  constructor(runs: readonly RunState[]) {
    this.runs = runs;
  }

  async list(): Promise<RunState[]> {
    return [...this.runs];
  }

  async update(run: RunState): Promise<void> {
    if (run.status === "failed") {
      this.failedUpdates.push(run);
      this.runs = this.runs.map((existing) => (existing.runId === run.runId ? run : existing));
      return;
    }
    throw new Error("模拟持久化失败：恢复执行落盘失败");
  }

  async create(_run: RunState): Promise<void> {
    throw new Error("not used");
  }

  async createIfAbsent(_run: RunState): Promise<boolean> {
    throw new Error("not used");
  }

  async getById(runId: string): Promise<RunState | undefined> {
    return this.runs.find((run) => run.runId === runId);
  }

  async listByWorkflow(_workflowId: string): Promise<RunState[]> {
    throw new Error("not used");
  }
}

describe("recoverInterruptedRuns 失败路径", () => {
  it("恢复失败（构造异常）→ run 被标记 failed → 下次 scanRecoverableRuns 不再识别", async () => {
    // 合法 workflow（start 节点 Idle → continueRun 走 runFrom → persist 落盘抛异常），status 仍 running。
    const badRun: RunState = {
      ...runState("bad-recovery", "running"),
      workflow: { id: "bad-wf", name: "bad", version: "0.1.0", nodes: [makeNode("start", "start")], edges: [] },
      nodeStates: { start: "Idle" },
    };
    const store = new ThrowingPersistStore([badRun]);
    // 恢复执行：persistRunState(running) 抛 → catch 标记 failed；recoverInterruptedRuns 不抛（单 run 不阻塞）。
    await recoverInterruptedRuns(store, { templatesRootDir: TEMP_BASE, groupsRootDir: TEMP_BASE });
    expect(store.failedUpdates).toHaveLength(1);
    expect(store.failedUpdates[0]?.runId).toBe("bad-recovery");
    expect(store.failedUpdates[0]?.status).toBe("failed");
    // 标记 failed 后：下次启动 scan 不再识别该 run（死循环解除）。
    expect(scanRecoverableRuns(await store.list())).toHaveLength(0);
  });

  it("标记 failed 本身也失败 → 不抛给调用方（内层 try 兜底），其余 run 继续", async () => {
    // update 一律抛错（含 failed 标记）：恢复执行落盘抛 → catch 内 update 也抛 → 被内层 try 吞掉，recoverInterruptedRuns 正常返回。
    const store = new (class implements RunStateStoreLike {
      async list(): Promise<RunState[]> {
        return [{
          ...runState("always-fail", "running"),
          workflow: { id: "always-fail-wf", name: "always-fail", version: "0.1.0", nodes: [makeNode("start", "start")], edges: [] },
          nodeStates: { start: "Idle" },
        }];
      }
      async update(_run: RunState): Promise<void> {
        throw new Error("always throws");
      }
      async create(_run: RunState): Promise<void> {
        throw new Error("not used");
      }
      async createIfAbsent(_run: RunState): Promise<boolean> {
        throw new Error("not used");
      }
      async getById(_runId: string): Promise<RunState | undefined> {
        return undefined;
      }
      async listByWorkflow(_workflowId: string): Promise<RunState[]> {
        throw new Error("not used");
      }
    })();
    await expect(
      recoverInterruptedRuns(store, { templatesRootDir: TEMP_BASE, groupsRootDir: TEMP_BASE }),
    ).resolves.toBeUndefined();
  });
});
