// 断点快照构建与恢复辅助：Engine 内部状态 ↔ RunState 双向转换（纯函数，避免 Engine 行数膨胀）。
// 深拷贝复用公共 utils/deepCopy（含 subworkflow 嵌套），保证快照与引擎内部隔离。
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { HumanTask } from "../human/types.js";
import type { Workflow } from "../model/types.js";
import type { RunState } from "../runstate/types.js";
import { deepCopyRecord } from "../utils/deepCopy.js";
import type { ExecutionResult } from "./Engine.js";
import type { NodeStatus } from "./NodeState.js";
import { NodeStateMachine } from "./NodeState.js";

// 保持既有公共导出：Engine 仍从本模块 import deepCopyWorkflow。
export { deepCopyWorkflow } from "../utils/deepCopy.js";

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
