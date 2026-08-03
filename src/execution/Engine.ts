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

/** 节点快照：nodeId → 最终状态。 */
export interface EngineNodeSnapshot {
  readonly nodeId: string;
  readonly status: NodeStatus;
}
/** 一次 run 的完整执行结果。 */
export interface ExecutionResult {
  readonly workflowId: string;
  readonly status: "success" | "failed";
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
}
export interface ExecutionEngineOptions {
  /** 节点注册表，默认全局 registry。 */
  readonly registry?: NodeRegistry;
  readonly events?: ExecutionEvents;
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
  constructor(workflow: Workflow, options: ExecutionEngineOptions = {}) {
    this.#workflow = workflow;
    this.#options = options;
    this.#registry = options.registry ?? registry;
    this.#nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
    this.#incoming = buildIncomingEdges(workflow.edges);
    this.#context = this.createContext();
  }
  /** 执行期间节点产生的日志。 */
  get logs(): readonly EngineLogEntry[] {
    return [...this.#logs];
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
    for (const nodeId of topoSort(this.#workflow)) {
      const failedMessage = await this.runNode(nodeId);
      if (failedMessage !== undefined) {
        // 失败即停：后续节点保持 Idle。
        const result = this.buildResult("failed", startTime, failedMessage);
        this.#options.events?.onComplete?.(result);
        return result;
      }
    }
    const result = this.buildResult("success", startTime);
    this.#options.events?.onComplete?.(result);
    return result;
  }
  /** 调度单个节点。返回 undefined=正常（Success/Skipped），否则为失败消息。 */
  private async runNode(nodeId: string): Promise<string | undefined> {
    const node = this.#nodeById.get(nodeId);
    const machine = this.#machines.get(nodeId);
    if (node === undefined || machine === undefined) return undefined;
    machine.transitionTo("Running");
    this.#states.set(nodeId, "Running");
    this.emitStateChange(nodeId, "Idle", "Running");
    const incoming = this.#incoming.get(nodeId) ?? [];
    if (!this.shouldExecute(incoming)) {
      machine.transitionTo("Skipped");
      this.#states.set(nodeId, "Skipped");
      this.emitStateChange(nodeId, "Running", "Skipped");
      return undefined;
    }
    this.transferPortData(node, incoming);
    try {
      const def = this.#registry.get(node.type);
      const outputValues = await def.execute(this.createNodeContext(node));
      this.#outputs.set(node.id, outputValues);
      machine.transitionTo("Success");
      this.#states.set(nodeId, "Success");
      this.emitStateChange(nodeId, "Running", "Success");
      return undefined;
    } catch (err) {
      machine.transitionTo("Failed");
      this.#states.set(nodeId, "Failed");
      this.emitStateChange(nodeId, "Running", "Failed");
      const message = `${node.name}(${node.id}) failed: ${err instanceof Error ? err.message : String(err)}`;
      this.#options.events?.onError?.(err instanceof Error ? err : new Error(message));
      return message;
    }
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
    status: "success" | "failed",
    startTime: number,
    errorMessage?: string,
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
    return errorMessage === undefined
      ? { ...base }
      : { ...base, error: errorMessage };
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
