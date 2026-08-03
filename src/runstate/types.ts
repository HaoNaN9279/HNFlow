// RunState 领域类型契约：断点续跑所需的完整运行时快照。
import type { NodeStatus } from "../execution/NodeState.js";
import type { Workflow } from "../model/types.js";

/** 一次工作流运行的断点快照，恢复时据此直接重建执行状态。 */
export interface RunState {
  readonly runId: string; // randomUUID
  readonly workflowId: string;
  readonly workflow: Workflow; // 完整快照（含内嵌子图），恢复时直接重建
  readonly nodeStates: Record<string, NodeStatus>;
  readonly nodeOutputs: Record<string, Record<string, unknown>>;
  readonly contextSnapshot: {
    readonly global: Record<string, unknown>;
    readonly workflow: Record<string, unknown>;
    readonly node: Record<string, Record<string, unknown>>;
  }; // WorkflowContext.getSnapshot 形状
  readonly pendingNodeId?: string; // 挂起节点
  readonly pendingTaskId?: string; // 挂起任务
  readonly status: "running" | "waiting" | "success" | "failed";
  readonly error?: string;
  readonly updatedAt: number;
}
