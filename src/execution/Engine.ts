// 串行执行引擎：拓扑排序 → 逐节点调度 → 端口数据流 → 状态流转 → 事件回调 → 断点持久化；AI 中断（v0.2.1）挂起/恢复逻辑在 ai-interrupt.ts，本文件只留引擎侧调度与事务边界。
import { randomUUID } from "node:crypto";
import type { Edge, Node, Workflow } from "../model/types.js";
import { detectCycle } from "../model/validate.js";
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { NodeStatus } from "./NodeState.js";
import { NodeStateMachine } from "./NodeState.js";
import { shouldExecute, transferPortData, type EngineReadState } from "./engine-util.js";
import type { NodeExecutionContext } from "./types.js";
import type { NodeRegistry } from "../nodes/registry.js";
import { registry } from "../nodes/registry.js";
import { HumanTaskStore, InvalidTaskStateError } from "../human/HumanTaskStore.js";
import type { HumanTask, HumanTaskSpec } from "../human/types.js";
import { RunStateStore } from "../runstate/RunStateStore.js";
import type { RunState } from "../runstate/types.js";
import type { HumanTaskStoreLike, RunStateStoreLike } from "../db/stores/types.js";
import type { ExecutionLogStore } from "../logs/ExecutionLogStore.js";
import { AiInterruptRequiredError, type AIExecutionResult } from "../ai/executor.js";
import { SqliteHumanTaskStore, SqliteRunStateStore, type SqliteDatabase } from "../db/index.js";
import { beginAiTransaction, isAiInterruptTask, resumeAiTask, skipAiTask, suspendAiNode, type AiOps, type AIResumeContext } from "./ai-interrupt.js";
import { buildIncomingEdges, buildResultFromEngine, buildRunStateFromEngine, deepCopyWorkflow, rebuildContext, rebuildMachines, topoSort } from "./runstate-persist.js";
export type { AIResumeContext } from "./ai-interrupt.js";
export { topoSort } from "./runstate-persist.js";
/** 节点快照：nodeId → 最终状态。 */
export interface EngineNodeSnapshot { readonly nodeId: string; readonly status: NodeStatus; }
export interface ExecutionResult {
  readonly workflowId: string;
  readonly status: "success" | "failed" | "waiting";
  readonly waitingTask?: HumanTask;
  readonly nodeStates: Record<string, NodeStatus>;
  readonly nodeOutputs: Record<string, Record<string, unknown>>;
  readonly error?: string;
  readonly startTime: number;
  readonly endTime: number;
}
export interface ExecutionEvents {
  readonly onNodeStateChange?: (info: { readonly nodeId: string; readonly from: NodeStatus; readonly to: NodeStatus }) => void;
  readonly onComplete?: (result: ExecutionResult) => void;
  readonly onError?: (error: Error) => void;
  readonly onHumanTaskCreated?: (task: HumanTask) => void;
}
export interface ExecutionEngineOptions {
  readonly registry?: NodeRegistry;
  readonly events?: ExecutionEvents;
  readonly humanTaskStore?: HumanTaskStoreLike;
  readonly workflowVariables?: Record<string, unknown>;
  readonly runStateStore?: RunStateStoreLike;
  readonly runId?: string;
  readonly persist?: boolean;
  /** 执行日志持久化 store：节点 logger 产生的日志在记录内存日志的同时转发入缓冲（flush 由 store 自行管理）。 */
  readonly logStore?: ExecutionLogStore;
  /** AI 中断 checkpoint 配置：提供 sharedDb 时引擎在 ai 节点执行期间开启事务（AC3 三写同事务）。 */
  readonly aiCheckpoint?: { readonly dbPath: string; readonly sharedDb?: SqliteDatabase };
  /** AI 中断恢复回调：注入方闭包持有 model/tools/interrupt 配置，引擎传 thread/checkpoint/decisions。 */
  readonly aiResumeHandler?: (context: AIResumeContext) => Promise<AIExecutionResult>;
}
export interface EngineLogEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data: unknown | undefined;
}
function assertNever(value: never): never {
  throw new Error(`unreachable value: ${String(value)}`);
}
/** 节点请求人工介入的信号：由 ctx.suspend 抛出，引擎识别后转入挂起流程（不视为失败）。 */
export class HumanTaskRequiredError extends Error {
  readonly name = "HumanTaskRequiredError";
  constructor(readonly spec: HumanTaskSpec) {
    super(`human task required: ${spec.title}`);
  }
}
/** 子工作流挂起信号：由 subworkflow 节点抛出，父引擎透传（复用子图已创建任务，不重复创建）。 */
export class SubworkflowWaitingError extends Error {
  readonly name = "SubworkflowWaitingError";
  constructor(readonly task: HumanTask) {
    super(`subworkflow waiting for human task: ${task.title}`);
  }
}
type RunNodeOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "waiting"; readonly task: HumanTask };
export class ExecutionEngine {
  readonly #workflow: Workflow;
  readonly #options: ExecutionEngineOptions;
  readonly #registry: NodeRegistry;
  readonly #nodeById: Map<string, Node>;
  readonly #incoming: Map<string, Edge[]>;
  readonly #runId: string;
  #context: WorkflowContext;
  #states = new Map<string, NodeStatus>();
  #outputs = new Map<string, Record<string, unknown>>();
  #machines = new Map<string, NodeStateMachine>();
  #logs: EngineLogEntry[] = [];
  #pendingNodeId: string | undefined;
  #humanTaskStore: HumanTaskStoreLike | undefined;
  #runStateStore: RunStateStoreLike | undefined;
  #runActive = false;
  constructor(workflow: Workflow, options: ExecutionEngineOptions = {}) {
    this.#workflow = workflow;
    this.#options = options;
    this.#registry = options.registry ?? registry;
    this.#runId = options.runId ?? randomUUID();
    this.#nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
    this.#incoming = buildIncomingEdges(workflow.edges);
    this.#context = this.createContext();
  }
  get logs(): readonly EngineLogEntry[] { return [...this.#logs]; }
  get pendingNodeId(): string | undefined { return this.#pendingNodeId; }
  get runId(): string { return this.#runId; }
  /** 只读态：run 进行中、挂起中或恢复执行中为 true；尚未 run 或已结束为 false。 */
  get isReadOnly(): boolean { return this.#runActive; }
  /** 当前工作流的不可变深拷贝（含嵌套 subworkflow，调用方修改不影响引擎内部）。 */
  get workflowSnapshot(): Workflow { return deepCopyWorkflow(this.#workflow); }
  async run(): Promise<ExecutionResult> {
    this.resetState();
    const cycle = detectCycle(this.#workflow);
    if (cycle.hasCycle) {
      throw new Error(`workflow cycle detected: ${cycle.path.join(" -> ")}`);
    }
    return this.runFrom(0);
  }
  async runFrom(startIndex: number): Promise<ExecutionResult> {
    this.#runActive = true;
    if (this.#options.persist === true) {
      await this.persistRunState("running");
    }
    return this.runRemaining(topoSort(this.#workflow), startIndex, Date.now());
  }
  /** 从断点快照恢复内部状态（states/outputs/context/machines），之后可 runFrom/resume 继续。 */
  restoreState(nodeStates: Record<string, NodeStatus>, nodeOutputs: Record<string, Record<string, unknown>>, contextSnapshot: RunState["contextSnapshot"]): void {
    this.#states = new Map(Object.entries(nodeStates));
    this.#outputs = new Map(Object.entries(nodeOutputs));
    this.#context = rebuildContext(contextSnapshot);
    this.#machines = rebuildMachines(this.#workflow, nodeStates);
    this.#runActive = true;
  }
  /** 从 startIndex 起执行拓扑序剩余节点：跑完 success；失败即停；挂起 waiting。 */
  private async runRemaining(
    order: readonly string[],
    startIndex: number,
    startTime: number,
  ): Promise<ExecutionResult> {
    const persist = this.#options.persist === true;
    let savedError: string | undefined;
    for (const nodeId of order.slice(startIndex)) {
      const outcome = await this.runNode(nodeId);
      switch (outcome.kind) {
        case "failed": {
          // finally 链：保留首个主错误并立即持久化（避免后续 finally 含挂起时丢失），不终止循环，finally 仍可执行。
          savedError ??= outcome.message;
          if (persist) await this.persistRunState("failed", { error: savedError });
          break;
        }
        case "waiting": {
          this.#pendingNodeId = nodeId;
          if (persist) await this.persistRunState("waiting", { pendingNodeId: nodeId, pendingTaskId: outcome.task.id });
          const result = buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "waiting", startTime, undefined, outcome.task);
          this.#options.events?.onComplete?.(result);
          return result;
        }
        case "ok":
          // 已进入失败模式（savedError 非空）时不再覆盖为 running：后续 finally/Skipped 节点执行不应回退断点状态。
          if (persist && savedError === undefined) await this.persistRunState("running");
          break;
        default:
          assertNever(outcome);
      }
    }
    if (savedError !== undefined) {
      // 主错误保留：全部 finally 已尝试，最终以 failed 收尾（此前每步已持久化，此处不再重复落盘）。
      this.#runActive = false;
      const result = buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "failed", startTime, savedError);
      this.#options.events?.onComplete?.(result);
      return result;
    }
    if (persist) await this.persistRunState("success");
    this.#runActive = false;
    const result = buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "success", startTime);
    this.#options.events?.onComplete?.(result);
    return result;
  }
  /** 调度单个节点：ok=正常（Success/Skipped），failed=失败消息，waiting=挂起。 */
  private async runNode(nodeId: string): Promise<RunNodeOutcome> {
    const node = this.#nodeById.get(nodeId);
    const machine = this.#machines.get(nodeId);
    if (node === undefined || machine === undefined) return { kind: "ok" };
    const previous = this.#states.get(nodeId) ?? "Idle";
    machine.transitionTo("Running");
    this.#states.set(nodeId, "Running");
    this.emitStateChange(nodeId, previous, "Running");
    const incoming = this.#incoming.get(nodeId) ?? [];
    const state: EngineReadState = { states: this.#states, outputs: this.#outputs, nodeById: this.#nodeById };
    if (!shouldExecute(incoming, state)) {
      machine.transitionTo("Skipped");
      this.#states.set(nodeId, "Skipped");
      this.emitStateChange(nodeId, "Running", "Skipped");
      return { kind: "ok" };
    }
    transferPortData(node, incoming, state, (path, val) => this.#context.setByPath(path, val));
    // AI 中断事务：ai 节点 + SQLite 共享连接时在 execute 前开启，覆盖 checkpoint+HumanTask+RunState 三写（AC3）；无中断 rollback，中断 → suspendAiNode 事务内三写后 commit。
    const aiTx = beginAiTransaction(this.#options.aiCheckpoint, node);
    try {
      const def = this.#registry.get(node.type);
      const outputValues = await def.execute(this.createNodeContext(node));
      this.#outputs.set(node.id, outputValues);
      machine.transitionTo("Success");
      this.#states.set(nodeId, "Success");
      this.emitStateChange(nodeId, "Running", "Success");
      aiTx?.rollback();
      return { kind: "ok" };
    } catch (err) {
      if (err instanceof HumanTaskRequiredError) {
        aiTx?.rollback();
        return await this.suspendNode(node, machine, err);
      }
      if (err instanceof SubworkflowWaitingError) {
        // 子工作流透传：复用子图已创建任务，不重复创建。
        aiTx?.rollback();
        machine.transitionTo("WaitingForHuman");
        this.#states.set(node.id, "WaitingForHuman");
        this.emitStateChange(node.id, "Running", "WaitingForHuman");
        this.#options.events?.onHumanTaskCreated?.(err.task);
        return { kind: "waiting", task: err.task };
      }
      if (err instanceof AiInterruptRequiredError) {
        return await suspendAiNode(this.aiOps(), node, machine, err, aiTx);
      }
      aiTx?.rollback();
      machine.transitionTo("Failed");
      this.#states.set(nodeId, "Failed");
      this.emitStateChange(nodeId, "Running", "Failed");
      const message = `${node.name}(${node.id}) failed: ${err instanceof Error ? err.message : String(err)}`;
      this.#options.events?.onError?.(err instanceof Error ? err : new Error(message));
      return { kind: "failed", message };
    }
  }
  /** 挂起流程：转入 WaitingForHuman → 创建并持久化任务（按 workflowId+nodeId 查 pending 复用）。 */
  private async suspendNode(node: Node, machine: NodeStateMachine, signal: HumanTaskRequiredError): Promise<RunNodeOutcome> {
    machine.transitionTo("WaitingForHuman");
    this.#states.set(node.id, "WaitingForHuman");
    this.emitStateChange(node.id, "Running", "WaitingForHuman");
    const existing = await this.humanTaskStore.findPending(this.#workflow.id, node.id);
    const task = existing ?? (await this.humanTaskStore.create({
      workflowId: this.#workflow.id,
      nodeId: node.id,
      nodeName: node.name,
      ...signal.spec,
    }));
    this.#options.events?.onHumanTaskCreated?.(task);
    return { kind: "waiting", task };
  }
  /** 恢复执行：AI 中断任务走 resumeAiTask（agent 恢复，不重跑节点）；普通任务写入人工产物 → 标记完成 → 重跑剩余。 */
  async resume(taskId: string, result?: unknown): Promise<ExecutionResult> {
    const task = await this.requirePendingTask(taskId);
    if (isAiInterruptTask(task)) {
      return resumeAiTask(this.aiOps(), task, result);
    }
    this.#context.set("workflow", `task_result:${task.nodeId}`, result);
    await this.humanTaskStore.complete(taskId, result);
    return this.continueFrom(task, 0, "resume failed");
  }
  /** 跳过执行：AI 中断任务转 reject 决策恢复 agent（继续执行不重跑）；普通任务置 Skipped → 其后继续。 */
  async skip(taskId: string): Promise<ExecutionResult> {
    const task = await this.requirePendingTask(taskId);
    if (isAiInterruptTask(task)) {
      return skipAiTask(this.aiOps(), task);
    }
    const machine = this.#machines.get(task.nodeId);
    if (machine !== undefined) {
      machine.transitionTo("Skipped");
      this.#states.set(task.nodeId, "Skipped");
      this.emitStateChange(task.nodeId, "WaitingForHuman", "Skipped");
    }
    await this.humanTaskStore.skip(taskId);
    return this.continueFrom(task, 1, "skip failed");
  }
  /** 从任务节点（offset：0=重跑任务节点，1=跳过节点）继续执行剩余节点。 */
  private continueFrom(task: HumanTask, offset: number, failureMessage: string): Promise<ExecutionResult> {
    const order = topoSort(this.#workflow);
    const startIndex = this.taskStartIndex(task, order);
    if (startIndex === -1) {
      throw new Error(`${failureMessage}: task node not in workflow: ${task.nodeId}`);
    }
    this.#runActive = true;
    return this.runRemaining(order, startIndex + offset, Date.now());
  }
  private aiOps(): AiOps {
    return {
      workflow: this.#workflow,
      nodeById: this.#nodeById,
      machines: this.#machines,
      states: this.#states,
      outputs: this.#outputs,
      store: this.humanTaskStore,
      ai: this.#options.aiCheckpoint,
      aiResumeHandler: this.#options.aiResumeHandler,
      events: this.#options.events,
      topoSort,
      persistWaiting: async (nodeId, taskId) => {
        if (this.#options.persist !== true) return;
        await this.persistRunState("waiting", { pendingNodeId: nodeId, pendingTaskId: taskId });
      },
      emit: (nodeId, from, to) => this.emitStateChange(nodeId, from, to),
      setContext: (key, value) => this.#context.set("workflow", key, value),
      taskStartIndex: (task, order) => this.taskStartIndex(task, order),
      startRemaining: async (startIndex) => {
        this.#runActive = true;
        return this.runRemaining(topoSort(this.#workflow), startIndex, Date.now());
      },
    };
  }
  private sqliteAi(): { readonly dbPath: string; readonly sharedDb: SqliteDatabase } | undefined {
    const ai = this.#options.aiCheckpoint;
    if (ai !== undefined && ai.sharedDb !== undefined) return { dbPath: ai.dbPath, sharedDb: ai.sharedDb };
    return undefined;
  }
  private async requirePendingTask(taskId: string): Promise<HumanTask> {
    const task = await this.humanTaskStore.getById(taskId);
    if (task === undefined || task.status !== "pending") {
      throw new InvalidTaskStateError(taskId, task?.status ?? "not found");
    }
    return task;
  }
  private taskStartIndex(task: HumanTask, order: readonly string[]): number {
    const direct = order.indexOf(task.nodeId);
    if (direct !== -1) return direct;
    const segments = task.workflowId.split(":");
    const subNodeId = segments[segments.length - 1];
    return subNodeId === undefined ? -1 : order.indexOf(subNodeId);
  }
  get humanTaskStore(): HumanTaskStoreLike {
    if (this.#humanTaskStore === undefined) {
      const ai = this.sqliteAi();
      this.#humanTaskStore = ai !== undefined && this.#options.humanTaskStore === undefined
        ? new SqliteHumanTaskStore(ai.dbPath, ai.sharedDb)
        : (this.#options.humanTaskStore ?? new HumanTaskStore());
    }
    return this.#humanTaskStore;
  }
  get runStateStore(): RunStateStoreLike {
    if (this.#runStateStore === undefined) {
      const ai = this.sqliteAi();
      this.#runStateStore = ai !== undefined && this.#options.runStateStore === undefined
        ? new SqliteRunStateStore(ai.dbPath, ai.sharedDb)
        : (this.#options.runStateStore ?? new RunStateStore());
    }
    return this.#runStateStore;
  }
  getWorkflowVariable(key: string): unknown { return this.#context.get("workflow", key); }
  private createNodeContext(node: Node): NodeExecutionContext {
    const workflowId = this.#workflow.id;
    const context = this.#context;
    return {
      node,
      workflowId,
      humanTaskStore: this.humanTaskStore,
      registry: this.#registry,
      ...(this.#options.aiCheckpoint !== undefined ? { aiCheckpoint: this.#options.aiCheckpoint } : {}), // AI 中断 checkpoint 配置透传（T5.1）
      get: (scope, key) => context.get(scope, key),
      set: (scope, key, value) => context.set(scope, key, value),
      getByPath: (path) => context.getByPath(path),
      setByPath: (path, value) => context.setByPath(path, value),
      getAll: (scope) => context.getAll(scope),
      suspend: (spec) => { throw new HumanTaskRequiredError(spec); },
      // 节点执行进度钩子：子图容器（loop）每迭代完成后调用，触发断点持久化（快照内容由容器写入 node 级上下文，引擎不理解快照含义）。
      progress: async () => {
        if (this.#options.persist === true) await this.persistRunState("running");
      },
      logger: {
        info: (msg, data) => this.recordLog(workflowId, node, "info", msg, data),
        warn: (msg, data) => this.recordLog(workflowId, node, "warn", msg, data),
        error: (msg, data) => this.recordLog(workflowId, node, "error", msg, data),
      },
    };
  }
  private recordLog(workflowId: string, node: Node, level: "info" | "warn" | "error", message: string, data?: unknown): void {
    const prefix = `[workflow:${workflowId}] [node:${node.id}]`;
    this.#logs.push({ level, message, data });
    this.#options.logStore?.append({
      runId: this.#runId,
      workflowId,
      nodeId: node.id,
      level,
      message,
      ...(data === undefined ? {} : { data }),
    });
    if (level === "info") console.info(prefix, message, data);
    else if (level === "warn") console.warn(prefix, message, data);
    else console.error(prefix, message, data);
  }
  private emitStateChange(nodeId: string, from: NodeStatus, to: NodeStatus): void {
    this.#options.events?.onNodeStateChange?.({ nodeId, from, to });
  }
  private createContext(): WorkflowContext {
    return new WorkflowContext({
      ...(this.#workflow.globalVariables === undefined ? {} : { globalVariables: this.#workflow.globalVariables }),
      ...(this.#options.workflowVariables === undefined ? {} : { workflowVariables: this.#options.workflowVariables }),
    });
  }
  /** 落盘当前断点快照：组装 RunState（runstate-persist 纯函数）→ store.update（upsert）。 */
  private async persistRunState(status: RunState["status"], extra?: { readonly pendingNodeId?: string; readonly pendingTaskId?: string; readonly error?: string }): Promise<void> {
    const runState = buildRunStateFromEngine({
      runId: this.#runId,
      workflow: this.#workflow,
      nodeStates: this.#states,
      nodeOutputs: this.#outputs,
      contextSnapshot: this.#context.getSnapshot(),
      status,
      ...extra,
    });
    await this.runStateStore.update(runState);
  }
  private resetState(): void {
    this.#states = new Map();
    this.#outputs = new Map();
    this.#machines = new Map();
    this.#logs = [];
    this.#context = this.createContext();
    for (const node of this.#workflow.nodes) {
      this.#machines.set(node.id, new NodeStateMachine());
    }
  }
}