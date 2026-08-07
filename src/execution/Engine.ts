// 串行执行引擎：拓扑排序 → 逐节点调度 → 端口数据流 → 状态流转 → 事件回调 → 断点持久化；AI 中断（v0.2.1）挂起/恢复逻辑在 ai-interrupt.ts，本文件只留引擎侧调度与事务边界。
import { randomUUID } from "node:crypto";
import type { Edge, Node, Workflow } from "../model/types.js";
import { detectCycle } from "../model/validate.js";
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { NodeStatus } from "./NodeState.js";
import { NodeStateMachine } from "./NodeState.js";
import { DebugController } from "./DebugController.js";
import { createWorkflowContext, emitStateChange, shouldExecute, transferPortData, askReviewDecision, sandboxRootDirOption, type EngineLogEntry, type EngineReadState, type RunNodeOutcome, type WorkflowContextSnapshot } from "./engine-util.js";
import { EngineStores } from "./engine-stores.js";
import type { NodeExecutionContext, MergedGroups, McpServerPool } from "./types.js";
import { GroupsResolver } from "./groups-resolver.js";
import { registry, type NodeRegistry } from "../nodes/registry.js";
import { InvalidTaskStateError } from "../human/HumanTaskStore.js";
import type { HumanTask } from "../human/types.js";
import type { RunState } from "../runstate/types.js";
import type { HumanTaskStoreLike, RunStateStoreLike } from "../db/stores/types.js";
import type { ExecutionLogStore } from "../logs/ExecutionLogStore.js";
import { AiInterruptRequiredError, type AIExecutionResult } from "../ai/executor.js";
import type { SqliteDatabase } from "../db/index.js";
import { beginAiTransaction, isAiInterruptTask, resumeAiTask, skipAiTask, suspendAiNode, type AiOps, type AIResumeContext } from "./ai-interrupt.js";
import { buildIncomingEdges, buildResultFromEngine, buildRunStateFromEngine, deepCopyWorkflow, persistRunState, rebuildContext, rebuildMachines, topoSort, type PersistRunStateOps } from "./runstate-persist.js";
import { crashConfirmToWaiting, makeSuspendOps, shouldCrashConfirm, suspendToWaiting, assertValidTaskResult } from "./human-suspend.js";
import { HumanTaskRequiredError, SubworkflowPausedError, SubworkflowWaitingError } from "./errors.js";
import { ReviewRequiredError } from "../security/command-guard.js";
import { registerIdempotencyKey } from "./idempotency.js";
import { formatNodePath } from "./node-path.js";
export type { AIResumeContext } from "./ai-interrupt.js";
export { topoSort } from "./runstate-persist.js";
export { HumanTaskRequiredError, IdempotencyKeyConflictError, InvalidTaskResultError, SubworkflowPausedError, SubworkflowWaitingError } from "./errors.js";
export type { WorkflowContextSnapshot } from "./engine-util.js";
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
  /** 幂等键（v0.2.5 T2）：与 workflowId 组成判重键；persist 开启时 run 启动按此原子注册，重复提交抛 IdempotencyKeyConflictError。 */
  readonly idempotencyKey?: string;
  /** 执行日志持久化 store：节点 logger 产生的日志在记录内存日志的同时转发入缓冲（flush 由 store 自行管理）。 */
  readonly logStore?: ExecutionLogStore;
  /** AI 中断 checkpoint 配置：提供 sharedDb 时引擎在 ai 节点执行期间开启事务（AC3 三写同事务）。 */
  readonly aiCheckpoint?: { readonly dbPath: string; readonly sharedDb?: SqliteDatabase };
  /** AI 中断恢复回调：注入方闭包持有 model/tools/interrupt 配置，引擎传 thread/checkpoint/decisions。 */
  readonly aiResumeHandler?: (context: AIResumeContext) => Promise<AIExecutionResult>;
  readonly debugController?: DebugController;
  /** 容器节点判定回调（step-into 放行容器进入子图）：缺省由 DebugController 构造时注入。 */
  readonly isContainer?: (nodeId: string) => boolean;
  /** 功能组根目录（v0.3.1 T5）：提供后节点声明 capabilityGroups 时运行时加载并合并注入 ctx.activeGroups。 */
  readonly groupsRootDir?: string;
  /** 功能组缓存容量（默认 32）。 */
  readonly groupCacheMaxSize?: number;
  /** 功能组核心版本兼容（v0.3.2 T8）：默认不兼容抛错；true 仅 warn 继续。 */
  readonly allowIncompatibleGroups?: boolean;
  readonly templatesRootDir?: string; // 子工作流模板根目录（v0.3.3 T2）：缺省 "./templates"；仅 template 引用时读目录（无引用零 IO）。
  readonly mcpPool?: McpServerPool; // MCP 进程池（v0.4.2 D2）：AI 节点 activeGroups.mcps 声明时注入 MCP 工具；可选，未配置则 AI 节点不加载。
  readonly onReviewRequired?: (info: { readonly nodeId: string; readonly description: string }) => Promise<"approve" | "reject">; // 人工审核回调（v0.4.2 验收 2）：command reviewRequired 未批准时询问；approve 重跑节点，reject 落失败路径；缺省 reject。
  readonly sharedReviewApprovals?: Set<string>; readonly sandboxRootDir?: string; // 共享已批准审核集合（v0.4.3 子图透传）+ 沙箱根目录（v0.9.4）：file/command 路径约束，子图容器透传。
}
function assertNever(value: never): never { throw new Error(`unreachable value: ${String(value)}`); }
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
  #logs: EngineLogEntry[] = []; #pendingNodeId: string | undefined;
  #nodeDurations = new Map<string, number>();
  readonly #stores: EngineStores;
  #runActive = false;
  #groupsResolver: GroupsResolver | undefined; #templatesRootDir: string;
  readonly #approvedReviews: Set<string>; // 本次运行已批准审核节点（v0.4.2 验收 2）：approve 后 command 重跑放行；v0.4.3 子图透传共享集合。
  constructor(workflow: Workflow, options: ExecutionEngineOptions = {}) {
    this.#workflow = workflow;
    this.#options = options;
    this.#registry = options.registry ?? registry;
    this.#runId = options.runId ?? randomUUID();
    this.#nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
    this.#incoming = buildIncomingEdges(workflow.edges);
    this.#context = createWorkflowContext(this.#workflow, this.#options);
    this.#stores = new EngineStores(options); this.#templatesRootDir = options.templatesRootDir ?? "./templates"; this.#approvedReviews = options.sharedReviewApprovals ?? new Set(); // 子引擎经父注入共享已批准集合（v0.4.3）：approve 写回父集合。
    this.#groupsResolver = options.groupsRootDir === undefined ? undefined : new GroupsResolver({
      groupsRootDir: options.groupsRootDir,
      ...(options.groupCacheMaxSize === undefined ? {} : { groupCacheMaxSize: options.groupCacheMaxSize }),
      ...(options.allowIncompatibleGroups === undefined ? {} : { allowIncompatibleGroups: options.allowIncompatibleGroups }),
    });
    if (options.isContainer !== undefined && options.debugController !== undefined && !options.debugController.hasContainerJudge()) {
      options.debugController.setIsContainer(options.isContainer);
    }
  }
  get logs(): readonly EngineLogEntry[] { return [...this.#logs]; }
  get nodeDurations(): Readonly<Record<string, number>> { return Object.fromEntries(this.#nodeDurations); } get pendingNodeId(): string | undefined { return this.#pendingNodeId; }
  get runId(): string { return this.#runId; } get isReadOnly(): boolean { return this.#runActive; }
  /** 当前工作流的不可变深拷贝（含嵌套 subworkflow，调用方修改不影响引擎内部）。 */
  get workflowSnapshot(): Workflow { return deepCopyWorkflow(this.#workflow); }
  /** 当前工作流上下文的完整快照（global/workflow/node 三层；值为独立副本，调用方修改不影响引擎内部）。 */
  get contextSnapshot(): WorkflowContextSnapshot { return this.#context.getSnapshot(); }
  async run(): Promise<ExecutionResult> {
    this.resetState();
    const cycle = detectCycle(this.#workflow);
    if (cycle.hasCycle) throw new Error(`workflow cycle detected: ${cycle.path.join(" -> ")}`);
    return this.runFrom(0);
  }
  async runFrom(startIndex: number): Promise<ExecutionResult> {
    this.#runActive = true;
    if (this.#options.persist === true) {
      // 幂等注册（v0.2.5 T2）：persist("running") 之前按 workflowId+idempotencyKey 原子注册，重复提交抛冲突不执行。
      if (this.#options.idempotencyKey !== undefined) {
        await registerIdempotencyKey(this.runStateStore, buildRunStateFromEngine({ runId: this.#runId, workflow: this.#workflow, nodeStates: this.#states, nodeOutputs: this.#outputs, contextSnapshot: this.#context.getSnapshot(), status: "running", idempotencyKey: this.#options.idempotencyKey }));
      }
      await persistRunState(this.persistOps, "running");
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
  private emitComplete(result: ExecutionResult): ExecutionResult {
    this.#options.events?.onComplete?.(result);
    return result;
  }
  private async runRemaining(order: readonly string[], startIndex: number, startTime: number): Promise<ExecutionResult> {
    const persist = this.#options.persist === true;
    let savedError: string | undefined;
    for (const nodeId of order.slice(startIndex)) {
      const nodeStart = Date.now(); const outcome = await this.runNode(nodeId);
      this.#nodeDurations.set(nodeId, Date.now() - nodeStart); // runNode 任何返回都记录（ok/skipped/waiting/paused/failed）
      switch (outcome.kind) {
        case "failed": {
          savedError ??= outcome.message; // finally 链：保留首个主错误并立即持久化（后续 finally 仍可执行）
          if (persist) await persistRunState(this.persistOps, "failed", { error: savedError });
          break;
        }
        case "waiting": {
          this.#pendingNodeId = nodeId;
          if (persist) await persistRunState(this.persistOps, "waiting", { pendingNodeId: nodeId, pendingTaskId: outcome.task.id });
          return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "waiting", startTime, undefined, outcome.task));
        }
        case "paused": {
          const pauseNodeId = outcome.pendingNodeId ?? nodeId;
          this.#pendingNodeId = pauseNodeId;
          if (persist) await persistRunState(this.persistOps, "paused", { pendingNodeId: pauseNodeId, ...(outcome.workflowId === undefined ? {} : { pausedWorkflowId: outcome.workflowId }) });
          return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "paused", startTime, undefined, undefined, pauseNodeId));
        }
        case "ok":
          if (persist && savedError === undefined) await persistRunState(this.persistOps, "running"); // 失败模式后不覆盖 running（finally/Skipped 不回退）
          break;
        default:
          assertNever(outcome);
      }
    }
    if (savedError !== undefined) {
      this.#runActive = false; // 主错误保留：全部 finally 已尝试，最终以 failed 收尾
      return this.emitComplete(buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "failed", startTime, savedError));
    }
    if (persist) await persistRunState(this.persistOps, "success");
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
    emitStateChange(this.#options.events?.onNodeStateChange, nodeId, previous, "Running");
    this.recordLog(this.#workflow.id, node, "info", `node:start ${nodeId}`);
    const incoming = this.#incoming.get(nodeId) ?? [];
    const state: EngineReadState = { states: this.#states, outputs: this.#outputs, nodeById: this.#nodeById };
    if (!shouldExecute(incoming, state)) {
      machine.transitionTo("Skipped");
      this.#states.set(nodeId, "Skipped");
      emitStateChange(this.#options.events?.onNodeStateChange, nodeId, "Running", "Skipped");
      this.recordLog(this.#workflow.id, node, "info", `node:skip ${nodeId}`);
      return { kind: "ok" };
    }
    transferPortData(node, incoming, state, (path, val) => this.#context.setByPath(path, val));
    if (this.#options.debugController?.shouldPause(nodeId) === true) {
      machine.transitionTo("Paused");
      this.#states.set(nodeId, "Paused");
      emitStateChange(this.#options.events?.onNodeStateChange, nodeId, "Running", "Paused");
      this.recordLog(this.#workflow.id, node, "info", `node:waiting ${nodeId}`, { status: "Paused" });
      return { kind: "paused" };
    }
    // 功能组运行时加载（v0.3.1 T5）：execute 之前加载并合并注入 ctx.activeGroups；失败直接 Failed（错误含 guid@version+原因），不触发 crashConfirm/HumanTask。
    let activeGroups: MergedGroups | undefined;
    try {
      activeGroups = await this.#groupsResolver?.resolve(node);
    } catch (err) {
      return this.markNodeFailed(node, nodeId, machine, err);
    }
    const aiTx = beginAiTransaction(this.#options.aiCheckpoint, node); // AI 中断事务：覆盖 checkpoint+HumanTask+RunState 三写（AC3）
    try {
      const outputValues = await this.#registry.get(node.type).execute(this.createNodeContext(node, activeGroups));
      this.#outputs.set(node.id, outputValues);
      machine.transitionTo("Success");
      this.#states.set(nodeId, "Success");
      emitStateChange(this.#options.events?.onNodeStateChange, nodeId, "Running", "Success");
      this.recordLog(this.#workflow.id, node, "info", `node:end ${nodeId}`);
      aiTx?.rollback();
      return { kind: "ok" };
    } catch (err) {
      if (err instanceof HumanTaskRequiredError) {
        aiTx?.rollback();
        this.markWaiting(node, machine);
        const task = await suspendToWaiting(makeSuspendOps(this.#workflow.id, node, this.#runId, this.humanTaskStore), err.spec);
        this.#options.events?.onHumanTaskCreated?.(task);
        return { kind: "waiting", task };
      }
      if (err instanceof SubworkflowWaitingError) {
        aiTx?.rollback();
        this.markWaiting(node, machine); // 子工作流透传：复用子图已创建任务，不重复创建。
        this.#options.events?.onHumanTaskCreated?.(err.task);
        return { kind: "waiting", task: err.task };
      }
      if (err instanceof SubworkflowPausedError) {
        aiTx?.rollback();
        machine.transitionTo("Paused");
        this.#states.set(node.id, "Paused");
        emitStateChange(this.#options.events?.onNodeStateChange, node.id, "Running", "Paused");
        this.recordLog(this.#workflow.id, node, "info", `node:waiting ${node.id}`, { status: "Paused" });
        return { kind: "paused", pendingNodeId: err.pendingNodeId, workflowId: err.workflowId };
      }
      if (err instanceof AiInterruptRequiredError) {
        return await suspendAiNode(this.aiOps(), node, machine, err, aiTx);
      }
      if (err instanceof ReviewRequiredError) {
        // 人工审核（v0.4.2 验收 2）：approve → 记入已批准并重跑节点；reject → 落失败路径。
        if ((await askReviewDecision(this.#options.onReviewRequired, err.nodeId === "" ? node.id : err.nodeId, err.description)) === "approve") {
          aiTx?.rollback(); // 事务收尾（command 通常无 AI 事务；防御性）
          this.#approvedReviews.add(node.id);
          machine.restore("Idle"); // 状态机禁止 Running → Running：重跑前回退 Idle（节点未执行副作用，等价从头执行）。
          this.#states.set(node.id, "Idle");
          return this.runNode(node.id);
        }
      }
      aiTx?.rollback();
      const errMsg = err instanceof Error ? err.message : String(err);
      if (shouldCrashConfirm(this.#options.idempotencyKey, this.#registry.get(node.type).idempotent)) {
        const crash = await crashConfirmToWaiting(makeSuspendOps(this.#workflow.id, node, this.#runId, this.humanTaskStore), errMsg);
        if (crash.kind === "waiting") {
          this.markWaiting(node, machine);
          this.#options.events?.onHumanTaskCreated?.(crash.task);
          return crash;
        }
      }
      return this.markNodeFailed(node, nodeId, machine, err);
    }
  }
  /** 转 WaitingForHuman：状态机 + 状态 + 事件 + 日志（挂起与崩溃确认共用，Running → WaitingForHuman 合法）。 */
  private markWaiting(node: Node, machine: NodeStateMachine): void {
    machine.transitionTo("WaitingForHuman");
    this.#states.set(node.id, "WaitingForHuman");
    emitStateChange(this.#options.events?.onNodeStateChange, node.id, "Running", "WaitingForHuman");
    this.recordLog(this.#workflow.id, node, "info", `node:waiting ${node.id}`, { status: "WaitingForHuman" });
  }
  /** 节点失败落地：状态机转 Failed + 错误日志（data.nodePath 人类可读路径，v0.4.2 验收 5）+ onError 回调；子引擎 #workflow.id 已是父链（根:容器节点...）。 */
  private markNodeFailed(node: Node, nodeId: string, machine: NodeStateMachine, err: unknown): { kind: "failed"; message: string } {
    machine.transitionTo("Failed");
    this.#states.set(nodeId, "Failed");
    emitStateChange(this.#options.events?.onNodeStateChange, nodeId, "Running", "Failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    const nodePath = formatNodePath(this.#workflow.id, nodeId, (id) => this.#nodeById.get(id)?.name);
    this.recordLog(this.#workflow.id, node, "error", `node:error ${nodeId}: ${errMsg}`, { status: "Failed", nodePath });
    this.#options.events?.onError?.(err instanceof Error ? err : new Error(`${node.name}(${node.id}) failed: ${errMsg}`));
    return { kind: "failed", message: `${node.name}(${node.id}) failed: ${errMsg}` };
  }
  /** 恢复执行：AI 中断任务走 resumeAiTask（agent 恢复，不重跑节点）；普通任务写入人工产物 → 标记完成 → 重跑剩余。 */
  async resume(taskId: string, result?: unknown): Promise<ExecutionResult> {
    const task = await this.requirePendingTask(taskId);
    if (isAiInterruptTask(task)) {
      return resumeAiTask(this.aiOps(), task, result);
    }
    assertValidTaskResult(this.#nodeById, task, result); // v0.9.3：requireResult 节点空结果拒绝（子图任务跳过）
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
      emitStateChange(this.#options.events?.onNodeStateChange, task.nodeId, "WaitingForHuman", "Skipped");
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
      runId: this.#runId,
      ai: this.#options.aiCheckpoint,
      aiResumeHandler: this.#options.aiResumeHandler,
      events: this.#options.events,
      topoSort,
      persistWaiting: async (nodeId, taskId) => { if (this.#options.persist === true) await persistRunState(this.persistOps, "waiting", { pendingNodeId: nodeId, pendingTaskId: taskId }); },
      emit: (nodeId, from, to) => emitStateChange(this.#options.events?.onNodeStateChange, nodeId, from, to),
      setContext: (key, value) => this.#context.set("workflow", key, value),
      taskStartIndex: (task, order) => this.taskStartIndex(task, order),
      startRemaining: async (startIndex) => {
        this.#runActive = true;
        return this.runRemaining(topoSort(this.#workflow), startIndex, Date.now());
      },
    };
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
  /** 引擎存储（惰性创建，sqlite 共享 db 时同事务；EngineStores 持有）。 */
  get humanTaskStore(): HumanTaskStoreLike { return this.#stores.humanTaskStore; }
  get runStateStore(): RunStateStoreLike { return this.#stores.runStateStore; }
  getWorkflowVariable(key: string): unknown { return this.#context.get("workflow", key); }
  getWorkflowVariables(): Record<string, unknown> { return this.#context.getAll("workflow"); }
  private createNodeContext(node: Node, activeGroups?: MergedGroups): NodeExecutionContext {
    const workflowId = this.#workflow.id;
    const context = this.#context;
    return {
      node,
      workflowId,
      humanTaskStore: this.humanTaskStore,
      registry: this.#registry,
      ...(this.#options.debugController === undefined ? {} : { debugController: this.#options.debugController }),
      ...(this.#options.aiCheckpoint !== undefined ? { aiCheckpoint: this.#options.aiCheckpoint } : {}), // AI 中断 checkpoint 配置透传（T5.1）
      ...(activeGroups === undefined ? {} : { activeGroups }),
      ...(this.#options.groupsRootDir === undefined ? {} : { groupsRootDir: this.#options.groupsRootDir }),
      ...(this.#options.groupCacheMaxSize === undefined ? {} : { groupCacheMaxSize: this.#options.groupCacheMaxSize }),
      ...(this.#options.allowIncompatibleGroups === undefined ? {} : { allowIncompatibleGroups: this.#options.allowIncompatibleGroups }),
      ...(this.#templatesRootDir === undefined ? {} : { templatesRootDir: this.#templatesRootDir }), ...(sandboxRootDirOption(this.#options.sandboxRootDir)), // 模板根目录透传（v0.3.3 T2）+ 沙箱根目录透传（v0.9.4）：template 引用加载 / file·command 路径约束
      reviewApprovals: this.#approvedReviews, sharedReviewApprovals: this.#approvedReviews, // 已批准审核集合（v0.4.2 验收 2）+ 共享可变引用（v0.4.3 子图透传）：子引擎 approve 写回同一集合。
      ...(this.#options.onReviewRequired === undefined ? {} : { onReviewRequired: this.#options.onReviewRequired }), // 人工审核回调透传（v0.4.3 子图透传）：子图容器转发给子引擎询问。
      ...(this.#options.mcpPool === undefined ? {} : { mcpPool: this.#options.mcpPool }), // MCP 进程池透传（v0.4.2 D2）：activeGroups.mcps → MCP 工具注入
      // 子图透传（v0.2.5 T4）：runId 任务查重一致、幂等键子图内崩溃判定；progress 供子图容器迭代断点持久化。
      runId: this.#runId,
      ...(this.#options.idempotencyKey === undefined ? {} : { idempotencyKey: this.#options.idempotencyKey }),
      get: (scope, key) => context.get(scope, key),
      set: (scope, key, value) => context.set(scope, key, value),
      getByPath: (path) => context.getByPath(path),
      setByPath: (path, value) => context.setByPath(path, value),
      getAll: (scope) => context.getAll(scope),
      suspend: (spec) => { throw new HumanTaskRequiredError(spec); },
      progress: async () => { // 子图容器（loop）每迭代完成触发断点持久化（快照由容器写入 node 级上下文）
        if (this.#options.persist === true) await persistRunState(this.persistOps, "running");
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
  private get persistOps(): PersistRunStateOps {
    return { runId: this.#runId, workflow: this.#workflow, states: this.#states, outputs: this.#outputs, contextSnapshot: this.#context.getSnapshot(), idempotencyKey: this.#options.idempotencyKey, debugController: this.#options.debugController, store: this.runStateStore };
  }
  private resetState(): void {
    this.#states = new Map();
    this.#outputs = new Map();
    this.#machines = new Map();
    this.#logs = []; this.#nodeDurations = new Map(); // 本次运行重新计时（v0.9.2 执行数据分析）
    this.#context = createWorkflowContext(this.#workflow, this.#options);
    for (const node of this.#workflow.nodes) this.#machines.set(node.id, new NodeStateMachine());
  }
}