// 串行执行引擎（T7）：拓扑排序 → 逐节点调度 → 端口数据流 → 状态流转 → 事件回调。
// 失败即停（后续节点保持 Idle）；ifElse 未选中分支沿依赖传播 Skipped。
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

/** 节点快照：nodeId → 最终状态。 */
export interface EngineNodeSnapshot {
  readonly nodeId: string;
  readonly status: NodeStatus;
}
/** 一次 run 的完整执行结果。 */
export interface ExecutionResult {
  readonly workflowId: string;
  readonly status: "success" | "failed" | "waiting";
  /** 挂起（status="waiting"）时携带的人工任务记录。 */
  readonly waitingTask?: HumanTask;
  /** nodeId → 最终状态（未执行的节点保持 Idle）。 */
  readonly nodeStates: Record<string, NodeStatus>;
  /** nodeId → 输出端口值映射（仅成功执行的节点有记录）。 */
  readonly nodeOutputs: Record<string, Record<string, unknown>>;
  /** 失败时的错误消息。 */
  readonly error?: string;
  readonly startTime: number;
  readonly endTime: number;
}
/** 引擎事件回调：全部同步调用，保持确定性顺序。 */
export interface ExecutionEvents {
  readonly onNodeStateChange?: (info: {
    readonly nodeId: string;
    readonly from: NodeStatus;
    readonly to: NodeStatus;
  }) => void;
  readonly onComplete?: (result: ExecutionResult) => void;
  readonly onError?: (error: Error) => void;
  /** 人工任务已创建并持久化（挂起发生时）。 */
  readonly onHumanTaskCreated?: (task: HumanTask) => void;
}
export interface ExecutionEngineOptions {
  /** 节点注册表，默认全局 registry。 */
  readonly registry?: NodeRegistry;
  readonly events?: ExecutionEvents;
  /** 人工任务存储，默认懒加载 HumanTaskStore（human_tasks.json）。 */
  readonly humanTaskStore?: HumanTaskStore;
  /** 初始 workflow 级变量。 */
  readonly workflowVariables?: Record<string, unknown>;
}
/** 引擎收集的节点日志条目（便于测试断言）。 */
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
/** runNode 的三种结局：ok=Success/Skipped，failed=失败消息，waiting=挂起（携带已创建任务）。 */
type RunNodeOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "waiting"; readonly task: HumanTask };
/** Kahn 拓扑排序：预检已拦截环；孤立节点 indegree=0 自然入队。 */
function topoSort(workflow: Workflow): string[] {
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
/** 预构建「targetNodeId → 入边列表」索引。 */
function buildIncomingEdges(edges: readonly Edge[]): Map<string, Edge[]> {
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.targetNodeId);
    if (list === undefined) {
      incoming.set(edge.targetNodeId, [edge]);
    } else {
      list.push(edge);
    }
  }
  return incoming;
}
export class ExecutionEngine {
  readonly #workflow: Workflow;
  readonly #options: ExecutionEngineOptions;
  readonly #registry: NodeRegistry;
  readonly #nodeById: Map<string, Node>;
  readonly #incoming: Map<string, Edge[]>;
  #context: WorkflowContext;
  #states = new Map<string, NodeStatus>();
  #outputs = new Map<string, Record<string, unknown>>();
  #machines = new Map<string, NodeStateMachine>();
  #logs: EngineLogEntry[] = [];
  #pendingNodeId: string | undefined;
  #humanTaskStore: HumanTaskStore | undefined;
  constructor(workflow: Workflow, options: ExecutionEngineOptions = {}) {
    this.#workflow = workflow;
    this.#options = options;
    this.#registry = options.registry ?? registry;
    this.#nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
    this.#incoming = buildIncomingEdges(workflow.edges);
    this.#context = this.createContext();
    this.#pendingNodeId = undefined;
  }
  /** 执行期间节点产生的日志。 */
  get logs(): readonly EngineLogEntry[] {
    return [...this.#logs];
  }
  /** 当前挂起节点 id（未挂起为 undefined）。 */
  get pendingNodeId(): string | undefined {
    return this.#pendingNodeId;
  }
  async run(): Promise<ExecutionResult> {
    this.resetState();
    const startTime = Date.now();
    // 预检：环 → 抛错（消息含环路径）。
    const cycle = detectCycle(this.#workflow);
    if (cycle.hasCycle) {
      throw new Error(`workflow cycle detected: ${cycle.path.join(" -> ")}`);
    }
    // 空 nodes 直接返回 success。
    if (this.#workflow.nodes.length === 0) {
      const result = this.buildResult("success", startTime);
      this.#options.events?.onComplete?.(result);
      return result;
    }
    return this.runRemaining(topoSort(this.#workflow), 0, startTime);
  }
  /** 从 startIndex 起执行拓扑序剩余节点：跑完返回 success；失败即停；挂起返回 waiting。 */
  private async runRemaining(
    order: readonly string[],
    startIndex: number,
    startTime: number,
  ): Promise<ExecutionResult> {
    for (const nodeId of order.slice(startIndex)) {
      const outcome = await this.runNode(nodeId);
      switch (outcome.kind) {
        case "failed": {
          // 失败即停：后续节点保持 Idle。
          const result = this.buildResult("failed", startTime, outcome.message);
          this.#options.events?.onComplete?.(result);
          return result;
        }
        case "waiting": {
          this.#pendingNodeId = nodeId;
          const result = this.buildResult("waiting", startTime, undefined, outcome.task);
          this.#options.events?.onComplete?.(result);
          return result;
        }
        case "ok":
          break;
        default:
          assertNever(outcome);
      }
    }
    const result = this.buildResult("success", startTime);
    this.#options.events?.onComplete?.(result);
    return result;
  }
  /** 调度单个节点。ok=正常（Success/Skipped），failed=失败消息，waiting=挂起。 */
  private async runNode(nodeId: string): Promise<RunNodeOutcome> {
    const node = this.#nodeById.get(nodeId);
    const machine = this.#machines.get(nodeId);
    if (node === undefined || machine === undefined) return { kind: "ok" };
    // 正常首次执行 previous 为 Idle；resume 恢复时为 WaitingForHuman。
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
      machine.transitionTo("Failed");
      this.#states.set(nodeId, "Failed");
      this.emitStateChange(nodeId, "Running", "Failed");
      const message = `${node.name}(${node.id}) failed: ${err instanceof Error ? err.message : String(err)}`;
      this.#options.events?.onError?.(err instanceof Error ? err : new Error(message));
      return { kind: "failed", message };
    }
  }
  /** 挂起流程：转入 WaitingForHuman → 创建并持久化任务 → 触发 onHumanTaskCreated。 */
  private async suspendNode(
    node: Node,
    machine: NodeStateMachine,
    signal: HumanTaskRequiredError,
  ): Promise<RunNodeOutcome> {
    machine.transitionTo("WaitingForHuman");
    this.#states.set(node.id, "WaitingForHuman");
    this.emitStateChange(node.id, "Running", "WaitingForHuman");
    const task = await this.humanTaskStore().create({
      workflowId: this.#workflow.id,
      nodeId: node.id,
      nodeName: node.name,
      ...signal.spec,
    });
    this.#options.events?.onHumanTaskCreated?.(task);
    return { kind: "waiting", task };
  }
  /** 恢复执行：写入人工产物 → 标记任务完成 → 从挂起节点重跑剩余节点。 */
  async resume(taskId: string, result?: unknown): Promise<ExecutionResult> {
    const task = await this.requirePendingTask(taskId);
    this.#context.set("workflow", `task_result:${task.nodeId}`, result);
    await this.humanTaskStore().complete(taskId, result);
    const order = topoSort(this.#workflow);
    const startIndex = order.indexOf(task.nodeId);
    if (startIndex === -1) {
      throw new Error(`resume failed: task node not in workflow: ${task.nodeId}`);
    }
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
    await this.humanTaskStore().skip(taskId);
    const order = topoSort(this.#workflow);
    const startIndex = order.indexOf(task.nodeId);
    if (startIndex === -1) {
      throw new Error(`skip failed: task node not in workflow: ${task.nodeId}`);
    }
    return this.runRemaining(order, startIndex + 1, Date.now());
  }
  /** 校验任务存在且 pending，否则抛 InvalidTaskStateError。 */
  private async requirePendingTask(taskId: string): Promise<HumanTask> {
    const task = await this.humanTaskStore().getById(taskId);
    if (task === undefined || task.status !== "pending") {
      throw new InvalidTaskStateError(taskId, task?.status ?? "not found");
    }
    return task;
  }
  /** 人工任务存储：惰性初始化一次（未注入则新建 HumanTaskStore，落盘 human_tasks.json）。 */
  private humanTaskStore(): HumanTaskStore {
    if (this.#humanTaskStore === undefined) {
      this.#humanTaskStore = this.#options.humanTaskStore ?? new HumanTaskStore();
    }
    return this.#humanTaskStore;
  }
  /** 分支跳过（OR 汇合）：入边空 → true；任一入边激活 → true；全部不激活 → false。 */
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
  /** 端口数据流：上游成功输出写入下游输入端口 binding 槽；无入边的输入端口跳过。 */
  private transferPortData(node: Node, incoming: readonly Edge[]): void {
    for (const port of node.inputs) {
      if (port.binding === undefined) continue;
      const edge = incoming.find((candidate) => candidate.targetPortId === port.id);
      if (edge === undefined) continue;
      const sourceOutputs = this.#outputs.get(edge.sourceNodeId);
      if (sourceOutputs === undefined) continue;
      this.#context.setByPath(port.binding, sourceOutputs[edge.sourcePortId]);
    }
  }

  private createNodeContext(node: Node): NodeExecutionContext {
    const workflowId = this.#workflow.id;
    const context = this.#context;
    return {
      node,
      workflowId,
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

  private recordLog(
    workflowId: string,
    node: Node,
    level: "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void {
    const prefix = `[workflow:${workflowId}] [node:${node.id}]`;
    this.#logs.push({ level, message, data });
    switch (level) {
      case "info": console.info(prefix, message, data); break;
      case "warn": console.warn(prefix, message, data); break;
      case "error": console.error(prefix, message, data); break;
      default: assertNever(level);
    }
  }

  private emitStateChange(nodeId: string, from: NodeStatus, to: NodeStatus): void {
    this.#options.events?.onNodeStateChange?.({ nodeId, from, to });
  }

  private createContext(): WorkflowContext {
    const init: {
      globalVariables?: Record<string, unknown>;
      workflowVariables?: Record<string, unknown>;
    } = {};
    if (this.#workflow.globalVariables !== undefined) {
      init.globalVariables = { ...this.#workflow.globalVariables };
    }
    if (this.#options.workflowVariables !== undefined) {
      init.workflowVariables = this.#options.workflowVariables;
    }
    return new WorkflowContext(init);
  }

  private buildResult(
    status: "success" | "failed" | "waiting",
    startTime: number,
    errorMessage?: string,
    waitingTask?: HumanTask,
  ): ExecutionResult {
    const nodeStates: Record<string, NodeStatus> = {};
    for (const node of this.#workflow.nodes) {
      nodeStates[node.id] = this.#states.get(node.id) ?? "Idle";
    }
    const nodeOutputs: Record<string, Record<string, unknown>> = {};
    for (const [nodeId, outputs] of this.#outputs) {
      nodeOutputs[nodeId] = outputs;
    }
    const base = {
      workflowId: this.#workflow.id,
      status,
      nodeStates,
      nodeOutputs,
      startTime,
      endTime: Date.now(),
    };
    const withError =
      errorMessage === undefined ? base : { ...base, error: errorMessage };
    return status === "waiting" && waitingTask !== undefined
      ? { ...withError, waitingTask }
      : withError;
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
