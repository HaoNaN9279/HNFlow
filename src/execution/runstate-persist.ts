// 断点快照构建与恢复辅助：Engine 内部状态 ↔ RunState 双向转换（纯函数，避免 Engine 行数膨胀）。
// 深拷贝复用 editing 的递归模式（含 subworkflow 嵌套），保证快照与引擎内部隔离。
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { HumanTask } from "../human/types.js";
import type { Edge, Node, Port, Workflow } from "../model/types.js";
import type { RunState } from "../runstate/types.js";
import type { ExecutionResult } from "./Engine.js";
import type { NodeStatus } from "./NodeState.js";
import { NodeStateMachine } from "./NodeState.js";

/** 构建 RunState 所需的引擎内部状态（Engine.persistRunState 传入）。 */
export interface EngineStateForPersist {
  readonly runId: string;
  readonly workflow: Workflow;
  readonly nodeStates: ReadonlyMap<string, NodeStatus>;
  readonly nodeOutputs: ReadonlyMap<string, Record<string, unknown>>;
  readonly contextSnapshot: RunState["contextSnapshot"];
  readonly status: RunState["status"];
  readonly pendingNodeId?: string;
  readonly pendingTaskId?: string;
  readonly error?: string;
}

/** 组装断点快照：nodeStates 填满全部节点（未执行 Idle），nodeOutputs 值深拷贝保证快照独立。 */
export function buildRunStateFromEngine(state: EngineStateForPersist): RunState {
  const nodeStates: Record<string, NodeStatus> = {};
  for (const node of state.workflow.nodes) {
    nodeStates[node.id] = state.nodeStates.get(node.id) ?? "Idle";
  }
  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, outputs] of state.nodeOutputs) {
    nodeOutputs[nodeId] = deepCopyRecord(outputs);
  }
  const base: RunState = {
    runId: state.runId,
    workflowId: state.workflow.id,
    workflow: state.workflow,
    nodeStates,
    nodeOutputs,
    contextSnapshot: state.contextSnapshot,
    status: state.status,
    updatedAt: Date.now(),
  };
  return {
    ...base,
    ...(state.pendingNodeId === undefined ? {} : { pendingNodeId: state.pendingNodeId }),
    ...(state.pendingTaskId === undefined ? {} : { pendingTaskId: state.pendingTaskId }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

/** 按快照重建 WorkflowContext：global/workflow 直接初始化，node 级按 "node:<id>:<key>" 逐键还原。 */
export function rebuildContext(contextSnapshot: RunState["contextSnapshot"]): WorkflowContext {
  const ctx = new WorkflowContext({
    globalVariables: contextSnapshot.global,
    workflowVariables: contextSnapshot.workflow,
  });
  for (const [scope, store] of Object.entries(contextSnapshot.node)) {
    if (!scope.startsWith("node:")) continue;
    const nodeId = scope.slice("node:".length);
    for (const [key, value] of Object.entries(store)) {
      ctx.set(`node:${nodeId}`, key, value);
    }
  }
  return ctx;
}

/** 按快照重建节点状态机：每个节点 new NodeStateMachine，nodeStates 有值则 restore（不校验转移表）。 */
export function rebuildMachines(
  workflow: Workflow,
  nodeStates: Record<string, NodeStatus>,
): Map<string, NodeStateMachine> {
  const machines = new Map<string, NodeStateMachine>();
  for (const node of workflow.nodes) {
    const machine = new NodeStateMachine();
    const status = nodeStates[node.id];
    if (status !== undefined) machine.restore(status);
    machines.set(node.id, machine);
  }
  return machines;
}

/** 不可变深拷贝（含嵌套 subworkflow）：Engine.workflowSnapshot 消费。 */
export function deepCopyWorkflow(workflow: Workflow): Workflow {
  const copy: Workflow = {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    nodes: workflow.nodes.map(deepCopyNode),
    edges: workflow.edges.map(deepCopyEdge),
  };
  return workflow.globalVariables === undefined
    ? copy
    : { ...copy, globalVariables: deepCopyRecord(workflow.globalVariables) };
}

function deepCopyNode(node: Node): Node {
  const copy: Node = {
    id: node.id,
    type: node.type,
    name: node.name,
    params: deepCopyRecord(node.params),
    inputs: node.inputs.map(deepCopyPort),
    outputs: node.outputs.map(deepCopyPort),
  };
  const withPosition =
    node.position === undefined ? copy : { ...copy, position: { ...node.position } };
  return node.subworkflow === undefined
    ? withPosition
    : { ...withPosition, subworkflow: deepCopyWorkflow(node.subworkflow) };
}

function deepCopyPort(port: Port): Port {
  return {
    id: port.id,
    name: port.name,
    type: port.type,
    direction: port.direction,
    ...(port.binding === undefined ? {} : { binding: port.binding }),
  };
}

function deepCopyEdge(edge: Edge): Edge {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    sourcePortId: edge.sourcePortId,
    targetNodeId: edge.targetNodeId,
    targetPortId: edge.targetPortId,
  };
}

function deepCopyRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    copy[key] = deepCopyValue(record[key]);
  }
  return copy;
}

function deepCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepCopyValue);
  }
  if (isPlainObject(value)) {
    return deepCopyRecord(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 组装 ExecutionResult（Engine.buildResult 移出，纯函数）：nodeStates 填满全部节点，nodeOutputs 透传。 */
export function buildResultFromEngine(
  workflow: Workflow,
  states: ReadonlyMap<string, NodeStatus>,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  status: "success" | "failed" | "waiting",
  startTime: number,
  errorMessage?: string,
  waitingTask?: HumanTask,
): ExecutionResult {
  const nodeStates: Record<string, NodeStatus> = {};
  for (const node of workflow.nodes) {
    nodeStates[node.id] = states.get(node.id) ?? "Idle";
  }
  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, output] of outputs) {
    nodeOutputs[nodeId] = output;
  }
  const base = {
    workflowId: workflow.id,
    status,
    nodeStates,
    nodeOutputs,
    startTime,
    endTime: Date.now(),
  };
  const withError = errorMessage === undefined ? base : { ...base, error: errorMessage };
  return status === "waiting" && waitingTask !== undefined
    ? { ...withError, waitingTask }
    : withError;
}
