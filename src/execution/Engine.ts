// 串行执行引擎：拓扑排序 → 逐节点调度 → 端口数据流 → 状态流转 → 事件回调 → 断点持久化；AI 中断（v0.2.1）挂起/恢复逻辑在 ai-interrupt.ts，本文件只留引擎侧调度与事务边界。
import { randomUUID } from "node:crypto";
import type { Edge, Node, Workflow } from "../model/types.js";
import { detectCycle } from "../model/validate.js";
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { NodeStatus } from "./NodeState.js";
import { NodeStateMachine } from "./NodeState.js";
import { DebugController } from "./DebugController.js";
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
export interface ExecutionResult {
  readonly workflowId: string;
  readonly status: "success" | "failed" | "waiting" | "paused";
  readonly waitingTask?: HumanTask;
  readonly pendingNodeId?: string;
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
  readonly debugController?: DebugController;
  /** 容器节点判定回调（step-into 放行容器进入子图）：缺省由 DebugController 构造时注入。 */
  readonly isContainer?: (nodeId: string) => boolean;
}
export interface EngineLogEntry { readonly level: "info" | "warn" | "error"; readonly message: string; readonly data: unknown | undefined; }
function assertNever(value: never): never { throw new Error(`unreachable value: ${String(value)}`); }
/** 节点请求人工介入的信号：由 ctx.suspend 抛出，引擎识别后转入挂起流程（不视为失败）。 */
export class HumanTaskRequiredError extends Error {
  readonly name = "HumanTaskRequiredError";
  constructor(readonly spec: HumanTaskSpec) { super(`human task required: ${spec.title}`); }
}
/** 子工作流挂起信号：由 subworkflow 节点抛出，父引擎透传（复用子图已创建任务，不重复创建）。 */
export class SubworkflowWaitingError extends Error {
  readonly name = "SubworkflowWaitingError";
  constructor(readonly task: HumanTask) { super(`subworkflow waiting for human task: ${task.title}`); }
}
/** 子工作流暂停信号：子引擎断点 paused 透传，父引擎容器转 Paused（pendingNodeId=子图首节点，workflowId 链还原调用栈）。 */
export class SubworkflowPausedError extends Error {
  readonly name = "SubworkflowPausedError";
  constructor(readonly pendingNodeId: string, readonly workflowId: string) { super(`subworkflow paused at node: ${pendingNodeId}`); }
}
type RunNodeOutcome = { readonly kind: "ok" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "waiting"; readonly task: HumanTask } | { readonly kind: "paused"; readonly pendingNodeId?: string; readonly workflowId?: string };
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
    if (options.isContainer !== undefined && options.debugController !== undefined && !options.debugController.hasContainerJudge()) {
      options.debugController.setIsContainer(options.isContainer);
    }
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
    if (cycle.hasCycle) throw new Error(`workflow cycle detected: ${cycle.path.join(" -> ")}`);
    return this.runFrom(0);
  }
  async runFrom(startIndex: number): Promise<ExecutionResult> {
    this.#runActive = true;
    if (this.#options.persist === true) await this.persistRunState("running");
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
  private emitComplete(result: ExecutionResult): ExecutionResult {
    this.#options.events?.onComplete?.(result);
    return result;
  }
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
          savedError ??= outcome.message; // finally 链：保留首个主错误并立即持久化（后续 finally 仍可执行）
          if (persist) await this.persistRunState("failed", { error: savedError });
          break;
        }
        case "waiting": {
          this.#pendingNodeId = nodeId;
          if (persist) await this.persistRunState("waiting", { pendingNodeId: nodeId, pendingTaskId: outcome.task.id });
          return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "waiting", startTime, undefined, outcome.task));
        }
        case "paused": {
          const pauseNodeId = outcome.pendingNodeId ?? nodeId;
          this.#pendingNodeId = pauseNodeId;
          if (persist) await this.persistRunState("paused", { pendingNodeId: pauseNodeId, ...(outcome.workflowId === undefined ? {} : { pausedWorkflowId: outcome.workflowId }) });
          return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "paused", startTime, undefined, undefined, pauseNodeId));
        }
        case "ok":
          if (persist && savedError === undefined) await this.persistRunState("running"); // 失败模式后不覆盖 running（finally/Skipped 不回退）
          break;
        default:
          assertNever(outcome);
      }
    }
    if (savedError !== undefined) {
      this.#runActive = false; // 主错误保留：全部 finally 已尝试，最终以 failed 收尾
      return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "failed", startTime, savedError));
    }
    if (persist) await this.persistRunState("success");
    this.#runActive = false;
    return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "success", startTime));
  }
  private async runNode(nodeId: string): Promise<RunNodeOutcome> {
    const node = this.#nodeById.get(nodeId);
    const machine = this.#machines.get(nodeId);
    if (node === undefined || machine === undefined) return { kind: "ok" };
    const previous = this.#states.get(nodeId) ?? "Idle";
    machine.transitionTo("Running");
    this.#states.set(nodeId, "Running");
    this.emitStateChange(nodeId, previous, "Running");
    this.recordLog(this.#workflow.id, node, "info", `node:start ${nodeId}`);
    const incoming = this.#incoming.get(nodeId) ?? [];
    const state: EngineReadState = { states: this.#states, outputs: this.#outputs, nodeById: this.#nodeById };
    if (!shouldExecute(incoming, state)) {
      machine.transitionTo("Skipped");
      this.#states.set(nodeId, "Skipped");
      this.emitStateChange(nodeId, "Running", "Skipped");
      this.recordLog(this.#workflow.id, node, "info", `node:skip ${nodeId}`);
      return { kind: "ok" };
    }
    transferPortData(node, incoming, state, (path, val) => this.#context.setByPath(path, val));
    if (this.#options.debugController?.shouldPause(nodeId) === true) {
      machine.transitionTo("Paused");
      this.#states.set(nodeId, "Paused");
      this.emitStateChange(nodeId, "Running", "Paused");
      this.recordLog(this.#workflow.id, node, "info", `node:waiting ${nodeId}`, { status: "Paused" });
      return { kind: "paused" };
    }
    const aiTx = beginAiTransaction(this.#options.aiCheckpoint, node); // AI 中断事务：覆盖 checkpoint+HumanTask+RunState 三写（AC3）
    try {
      const outputValues = await this.#registry.get(node.type).execute(this.createNodeContext(node));
      this.#outputs.set(node.id, outputValues);
      machine.transitionTo("Success");
      this.#states.set(nodeId, "Success");
      this.emitStateChange(nodeId, "Running", "Success");
      this.recordLog(this.#workflow.id, node, "info", `node:end ${nodeId}`);
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
        this.recordLog(this.#workflow.id, node, "info", `node:waiting ${node.id}`, { status: "WaitingForHuman" });
        this.#options.events?.onHumanTaskCreated?.(err.task);
        return { kind: "waiting", task: err.task };
      }
      if (err instanceof SubworkflowPausedError) {
        aiTx?.rollback();
        machine.transitionTo("Paused");
        this.#states.set(node.id, "Paused");
        this.emitStateChange(node.id, "Running", "Paused");
        this.recordLog(this.#workflow.id, node, "info", `node:waiting ${node.id}`, { status: "Paused" });
        return { kind: "paused", pendingNodeId: err.pendingNodeId, workflowId: err.workflowId };
      }
      if (err instanceof AiInterruptRequiredError) {
        return await suspendAiNode(this.aiOps(), node, machine, err, aiTx);
      }
      aiTx?.rollback();
      machine.transitionTo("Failed");
      this.#states.set(nodeId, "Failed");
      this.emitStateChange(nodeId, "Running", "Failed");
      const errMsg = err instanceof Error ? err.message : String(err);
      this.recordLog(this.#workflow.id, node, "error", `node:error ${nodeId}: ${errMsg}`, { status: "Failed" });
      const message = `${node.name}(${node.id}) failed: ${errMsg}`;
      this.#options.events?.onError?.(err instanceof Error ? err : new Error(message));
      return { kind: "failed", message };
    }
  }
  /** 挂起流程：转入 WaitingForHuman → 创建并持久化任务（按 workflowId+nodeId 查 pending 复用）。 */
  private async suspendNode(node: Node, machine: NodeStateMachine, signal: HumanTaskRequiredError): Promise<RunNodeOutcome> {
    machine.transitionTo("WaitingForHuman");
    this.#states.set(node.id, "WaitingForHuman");
    this.emitStateChange(node.id, "Running", "WaitingForHuman");
    this.recordLog(this.#workflow.id, node, "info", `node:waiting ${node.id}`, { status: "WaitingForHuman" });
    const existing = await this.humanTaskStore.findPending(this.#workflow.id, node.id);
    const task = existing ?? (await this.humanTaskStore.create({ workflowId: this.#workflow.id, nodeId: node.id, nodeName: node.name, ...signal.spec }));
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
    if (startIndex === -1) throw new Error(`${failureMessage}: task node not in workflow: ${task.nodeId}`);
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
      persistWaiting: async (nodeId, taskId) => { if (this.#options.persist === true) await this.persistRunState("waiting", { pendingNodeId: nodeId, pendingTaskId: taskId }); },
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
    if (task === undefined || task.status !== "pending") throw new InvalidTaskStateError(taskId, task?.status ?? "not found");
    return task;
  }
  private taskStartIndex(task: HumanTask, order: readonly string[]): number {
    const direct = order.indexOf(task.nodeId);
    if (direct !== -1) return direct;
    // 子图任务：workflowId = 父id:容器节点id(:分支id)，从后往前逐段回溯匹配父图节点。
    const segments = task.workflowId.split(":");
    for (let i = segments.length - 1; i >= 0; i--) {
      const idx = order.indexOf(segments[i]!);
      if (idx !== -1) return idx;
    }
    return -1;
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
  /** workflow 作用域全量变量拷贝（内部 getAll 为独立拷贝，供并行分支 diff 合并用，不共享引用）。 */
  getWorkflowVariables(): Record<string, unknown> { return this.#context.getAll("workflow"); }
  private createNodeContext(node: Node): NodeExecutionContext {
    const workflowId = this.#workflow.id;
    const context = this.#context;
    return {
      node,
      workflowId,
      humanTaskStore: this.humanTaskStore,
      registry: this.#registry,
      ...(this.#options.debugController === undefined ? {} : { debugController: this.#options.debugController }),
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
  /** 落盘当前断点快照：paused 状态自动携带 debug 断点集合（从注入的 DebugController 读取）。 */
  private async persistRunState(status: RunState["status"], extra?: { readonly pendingNodeId?: string; readonly pendingTaskId?: string; readonly error?: string; readonly pausedWorkflowId?: string }): Promise<void> {
    const runState = buildRunStateFromEngine({
      runId: this.#runId,
      workflow: this.#workflow,
      nodeStates: this.#states,
      nodeOutputs: this.#outputs,
      contextSnapshot: this.#context.getSnapshot(),
      status,
      ...extra,
      ...(status === "paused" ? {
        debug: {
          breakpoints: this.#options.debugController?.breakpointIds() ?? [],
          ...(extra?.pausedWorkflowId === undefined ? {} : { pausedWorkflowId: extra?.pausedWorkflowId }),
        },
      } : {}),
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