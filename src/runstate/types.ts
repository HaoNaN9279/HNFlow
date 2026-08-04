// RunState 领域类型契约：断点续跑所需的完整运行时快照。
import type { NodeStatus } from "../execution/NodeState.js";
import type { Workflow } from "../model/types.js";

/** 一次工作流运行的断点快照，恢复时据此直接重建执行状态。 */
export interface RunState {
  readonly runId: string; // randomUUID
  readonly workflowId: string;
  /** 幂等键（v0.2.5 T2）：与 workflowId 组成判重键；缺失视为非幂等运行（恢复路径天然豁免）。 */
  readonly idempotencyKey?: string;
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
  readonly status: "running" | "waiting" | "success" | "failed" | "paused";
  readonly error?: string;
  /** 调试断点集合（v0.2.4）：暂停时落盘、恢复时还原。 */
  readonly debug?: {
    readonly breakpoints: readonly string[];
    /** 子图暂停点 workflowId 链（v0.2.4 T3）：子引擎 paused 透传时记录（父id:容器id...），恢复回溯容器节点用。 */
    readonly pausedWorkflowId?: string;
  };
  readonly updatedAt: number;
}
