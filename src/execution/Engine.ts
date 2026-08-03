// 串行执行引擎：拓扑排序 → 逐节点调度 → 端口数据流 → 状态流转 → 事件回调 → 断点持久化。
import { randomUUID } from "node:crypto";
import type { Edge, Node, Workflow } from "../model/types.js";
import { detectCycle } from "../model/validate.js";
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { NodeStatus } from "./NodeState.js";
import { NodeStateMachine } from "./NodeState.js";
import type { NodeExecutionContext } from "./types.js";
import type { NodeRegistry } from "../nodes/registry.js";
import { registry } from "../nodes/registry.js";
import { HumanTaskStore, InvalidTaskStateError } from "../human/HumanTaskStore.js";
import type { HumanTask, HumanTaskSpec } from "../human/types.js";
import { RunStateStore } from "../runstate/RunStateStore.js";
import type { RunState } from "../runstate/types.js";
import { buildResultFromEngine, buildRunStateFromEngine, deepCopyWorkflow, rebuildContext, rebuildMachines } from "./runstate-persist.js";
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
  readonly humanTaskStore?: HumanTaskStore;
  readonly workflowVariables?: Record<string, unknown>;
  readonly runStateStore?: RunStateStore;
  readonly runId?: string;
  readonly persist?: boolean;
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
export function topoSort(workflow: Workflow): string[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    const from = adj.get(edge.sourceNodeId);
    const to = indegree.get(edge.targetNodeId);
    if (from === undefined || to === undefined) continue;
    from.push(edge.targetNodeId);
    indegree.set(edge.targetNodeId, to + 1);
  }
  const queue: string[] = [];
  for (const node of workflow.nodes) {
    if (indegree.get(node.id) === 0) queue.push(node.id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const remaining = indegree.get(next);
      if (remaining === undefined) continue;
      const decremented = remaining - 1;
      indegree.set(next, decremented);
      if (decremented === 0) queue.push(next);
    }
  }
  return order;
}
function buildIncomingEdges(edges: readonly Edge[]): Map<string, Edge[]> {
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.targetNodeId) ?? [];
    list.push(edge);
    incoming.set(edge.targetNodeId, list);
  }
  return incoming;
}
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
  #humanTaskStore: HumanTaskStore | undefined;
  #runStateStore: RunStateStore | undefined;
  #runActive = false;
  constructor(workflow: Workflow, options: ExecutionEngineOptions = {}) {
    this.#workflow = workflow;
    this.#options = options;
    this.#registry = options.registry ?? registry;
    this.#runId = options.runId ?? randomUUID();
    this.#nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
    this.#incoming = buildIncomingEdges(workflow.edges);
    this.#context = this.createContext();
    this.#pendingNodeId = undefined;
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
  /** 从 startIndex 起执行拓扑序剩余节点（0 等价 run()）。恢复续跑入口，不重置状态。 */
  async runFrom(startIndex: number): Promise<ExecutionResult> {
    this.#runActive = true;
    if (this.#options.persist === true) {
      await this.persistRunState("running");
    }
    return this.runRemaining(topoSort(this.#workflow), startIndex, Date.now());
  }
  /** 从断点快照恢复内部状态（states/outputs/context/machines），之后可 runFrom/resume 继续。 */
  restoreState(
    nodeStates: Record<string, NodeStatus>,
    nodeOutputs: Record<string, Record<string, unknown>>,
    contextSnapshot: RunState["contextSnapshot"],
  ): void {
    this.#states = new Map(Object.entries(nodeStates));
    this.#outputs = new Map(Object.entries(nodeOutputs));
    this.#context = rebuildContext(contextSnapshot);
    this.#machines = rebuildMachines(this.#workflow, nodeStates);
    this.#pendingNodeId = undefined;
    this.#runActive = true;
  }
  /** 从 startIndex 起执行拓扑序剩余节点：跑完 success；失败即停；挂起 waiting。 */
  private async runRemaining(
    order: readonly string[],
    startIndex: number,
    startTime: number,
  ): Promise<ExecutionResult> {
    const persist = this.#options.persist === true;
    for (const nodeId of order.slice(startIndex)) {
      const outcome = await this.runNode(nodeId);
      switch (outcome.kind) {
        case "failed": {
          if (persist) await this.persistRunState("failed", { error: outcome.message });
          this.#runActive = false;
          const result = buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "failed", startTime, outcome.message);
          this.#options.events?.onComplete?.(result);
          return result;
        }
        case "waiting": {
          this.#pendingNodeId = nodeId;
          if (persist) {
            await this.persistRunState("waiting", { pendingNodeId: nodeId, pendingTaskId: outcome.task.id });
          }
          const result = buildResultFromEngine(this.#workflow, this.#states, this.#outputs, "waiting", startTime, undefined, outcome.task);
          this.#options.events?.onComplete?.(result);
          return result;
        }
        case "ok":
          if (persist) await this.persistRunState("running");
          break;
        default:
          assertNever(outcome);
      }
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
    if (!this.shouldExecute(incoming)) {
      machine.transitionTo("Skipped");
      this.#states.set(nodeId, "Skipped");
      this.emitStateChange(nodeId, "Running", "Skipped");
      return { kind: "ok" };
    }
    this.transferPortData(node, incoming);
    try {
      const def = this.#registry.get(node.type);
      const outputValues = await def.execute(this.createNodeContext(node));
      this.#outputs.set(node.id, outputValues);
      machine.transitionTo("Success");
      this.#states.set(nodeId, "Success");
      this.emitStateChange(nodeId, "Running", "Success");
      return { kind: "ok" };
    } catch (err) {
      if (err instanceof HumanTaskRequiredError) {
        return await this.suspendNode(node, machine, err);
      }
      if (err instanceof SubworkflowWaitingError) {
        // 子工作流透传：复用子图已创建任务，不重复创建。
        machine.transitionTo("WaitingForHuman");
        this.#states.set(node.id, "WaitingForHuman");
        this.emitStateChange(node.id, "Running", "WaitingForHuman");
        this.#options.events?.onHumanTaskCreated?.(err.task);
        return { kind: "waiting", task: err.task };
      }
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
  /** 恢复执行：写入人工产物 → 标记任务完成 → 从挂起节点重跑剩余节点。 */
  async resume(taskId: string, result?: unknown): Promise<ExecutionResult> {
    const task = await this.requirePendingTask(taskId);
    this.#context.set("workflow", `task_result:${task.nodeId}`, result);
    await this.humanTaskStore.complete(taskId, result);
    const order = topoSort(this.#workflow);
    const startIndex = this.taskStartIndex(task, order);
    if (startIndex === -1) {
      throw new Error(`resume failed: task node not in workflow: ${task.nodeId}`);
    }
    this.#runActive = true;
    return this.runRemaining(order, startIndex, Date.now());
  }
  /** 跳过执行：任务节点置 Skipped → 标记任务跳过 → 从其后一节点继续（下游自动跳过传播）。 */
  async skip(taskId: string): Promise<ExecutionResult> {
    const task = await this.requirePendingTask(taskId);
    const machine = this.#machines.get(task.nodeId);
    if (machine !== undefined) {
      machine.transitionTo("Skipped");
      this.#states.set(task.nodeId, "Skipped");
      this.emitStateChange(task.nodeId, "WaitingForHuman", "Skipped");
    }
    await this.humanTaskStore.skip(taskId);
    const order = topoSort(this.#workflow);
    const startIndex = this.taskStartIndex(task, order);
    if (startIndex === -1) {
      throw new Error(`skip failed: task node not in workflow: ${task.nodeId}`);
    }
    this.#runActive = true;
    return this.runRemaining(order, startIndex + 1, Date.now());
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
  get humanTaskStore(): HumanTaskStore {
    if (this.#humanTaskStore === undefined) {
      this.#humanTaskStore = this.#options.humanTaskStore ?? new HumanTaskStore();
    }
    return this.#humanTaskStore;
  }
  get runStateStore(): RunStateStore {
    if (this.#runStateStore === undefined) {
      this.#runStateStore = this.#options.runStateStore ?? new RunStateStore();
    }
    return this.#runStateStore;
  }
  getWorkflowVariable(key: string): unknown { return this.#context.get("workflow", key); }
  private shouldExecute(incoming: readonly Edge[]): boolean {
    if (incoming.length === 0) return true;
    return incoming.some((edge) => this.isActiveIncoming(edge));
  }
  /** 入边激活：源节点为 Success 且（非 ifElse 或对应源端口输出值 !== false）。 */
  private isActiveIncoming(edge: Edge): boolean {
    if (this.#states.get(edge.sourceNodeId) !== "Success") return false;
    const sourceNode = this.#nodeById.get(edge.sourceNodeId);
    if (sourceNode?.type === "ifElse") {
      const outputs = this.#outputs.get(edge.sourceNodeId);
      if (outputs !== undefined && outputs[edge.sourcePortId] === false) return false;
    }
    return true;
  }
  /** 端口数据流：上游成功输出写入下游输入端口 binding 槽；多激活入边聚合为数组。 */
  private transferPortData(node: Node, incoming: readonly Edge[]): void {
    for (const port of node.inputs) {
      if (port.binding === undefined) continue;
      const values: unknown[] = [];
      for (const edge of incoming) {
        if (edge.targetPortId !== port.id) continue;
        if (!this.isActiveIncoming(edge)) continue;
        const sourceOutputs = this.#outputs.get(edge.sourceNodeId);
        if (sourceOutputs === undefined) continue;
        values.push(sourceOutputs[edge.sourcePortId]);
      }
      if (values.length === 0) continue;
      const value = values.length === 1 ? values[0] : values;
      this.#context.setByPath(port.binding, value);
    }
  }
  private createNodeContext(node: Node): NodeExecutionContext {
    const workflowId = this.#workflow.id;
    const context = this.#context;
    return {
      node,
      workflowId,
      humanTaskStore: this.humanTaskStore,
      get: (scope, key) => context.get(scope, key),
      set: (scope, key, value) => context.set(scope, key, value),
      getByPath: (path) => context.getByPath(path),
      setByPath: (path, value) => context.setByPath(path, value),
      getAll: (scope) => context.getAll(scope),
      suspend: (spec) => {
        throw new HumanTaskRequiredError(spec);
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
    switch (level) {
      case "info": console.info(prefix, message, data); break;
      case "warn": console.warn(prefix, message, data); break;
      default: console.error(prefix, message, data); break;
    }
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
    this.#pendingNodeId = undefined;
    for (const node of this.#workflow.nodes) {
      this.#machines.set(node.id, new NodeStateMachine());
    }
  }
}