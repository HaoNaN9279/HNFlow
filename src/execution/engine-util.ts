// 引擎共享工具：入边激活判定 + 端口数据流 + 共享类型 + 上下文构造（从 Engine 抽取，保持 Engine ≤440 行）。
// 只依赖 model/context/human 类型与 NodeStatus，无循环依赖；纯函数，不持有引擎实例。
import type { Edge, Node, Workflow } from "../model/types.js";
import { WorkflowContext } from "../context/WorkflowContext.js";
import type { HumanTask } from "../human/types.js";
import type { NodeStatus } from "./NodeState.js";

/** 引擎日志条目（从 Engine.ts 移出控制行数；无外部 import 引用，re-export 需经 Engine 时改从本文件取）。 */
export interface EngineLogEntry { readonly level: "info" | "warn" | "error"; readonly message: string; readonly data: unknown | undefined; }

/** 引擎 runNode 结果（从 Engine.ts 移出控制行数）。 */
export type RunNodeOutcome = { readonly kind: "ok" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "waiting"; readonly task: HumanTask } | { readonly kind: "paused"; readonly pendingNodeId?: string; readonly workflowId?: string };

/** 构造引擎工作流上下文（globalVariables + workflowVariables 合并；从 Engine.createContext 移出控制行数）。 */
export function createWorkflowContext(workflow: Workflow, options: { readonly workflowVariables?: Record<string, unknown> }): WorkflowContext {
  return new WorkflowContext({
    ...(workflow.globalVariables === undefined ? {} : { globalVariables: workflow.globalVariables }),
    ...(options.workflowVariables === undefined ? {} : { workflowVariables: options.workflowVariables }),
  });
}

/** 引擎调度期只读快照：入边激活判定所需的最小内部状态。 */
export interface EngineReadState {
  readonly states: ReadonlyMap<string, NodeStatus>;
  readonly outputs: ReadonlyMap<string, Record<string, unknown>>;
  readonly nodeById: ReadonlyMap<string, Node>;
}

/** 单条入边是否激活：
 *  上游非 Success/Failed（Idle/Running/Skipped/WaitingForHuman）→ 不激活；
 *  上游 Failed → 仅目标为 finally 类型放行（失败后清理链仍执行），其余阻断；
 *  上游 Success → ifElse 假分支阻断；tryCatch 未输出端口（异常分支未激活）阻断。
 */
export function isActiveIncoming(edge: Edge, state: EngineReadState): boolean {
  const upstreamStatus = state.states.get(edge.sourceNodeId);
  if (upstreamStatus !== "Success" && upstreamStatus !== "Failed") return false;
  if (upstreamStatus === "Failed") {
    return state.nodeById.get(edge.targetNodeId)?.type === "finally";
  }
  const sourceNode = state.nodeById.get(edge.sourceNodeId);
  const portValue = state.outputs.get(edge.sourceNodeId)?.[edge.sourcePortId];
  if (sourceNode?.type === "ifElse" && portValue === false) return false;
  if (sourceNode?.type === "tryCatch" && portValue === undefined) return false;
  return true;
}

/** 节点是否应执行：无入边（根节点）→ 是；否则任一入边激活 → 是。 */
export function shouldExecute(incoming: readonly Edge[], state: EngineReadState): boolean {
  if (incoming.length === 0) return true;
  return incoming.some((edge) => isActiveIncoming(edge, state));
}

/** 端口数据流：激活上游输出写入下游输入端口 binding 槽；多激活入边聚合为数组。 */
export function transferPortData(
  node: Node,
  incoming: readonly Edge[],
  state: EngineReadState,
  setByPath: (path: string, value: unknown) => void,
): void {
  for (const port of node.inputs) {
    if (port.binding === undefined) continue;
    const values: unknown[] = [];
    for (const edge of incoming) {
      if (edge.targetPortId !== port.id) continue;
      if (!isActiveIncoming(edge, state)) continue;
      const sourceOutputs = state.outputs.get(edge.sourceNodeId);
      if (sourceOutputs === undefined) continue;
      values.push(sourceOutputs[edge.sourcePortId]);
    }
    if (values.length === 0) continue;
    const value = values.length === 1 ? values[0] : values;
    setByPath(port.binding, value);
  }
}

/** 人工审核决策（v0.4.2 验收 2）：command 节点 reviewRequired 未批准时引擎询问；approve 重跑，reject 失败。 */
export type ReviewDecision = "approve" | "reject";

/** 人工审核回调签名（Engine options.onReviewRequired 类型；经本文件消费，Engine 不直接引用 security 层）。 */
export type OnReviewRequired = (info: { readonly nodeId: string; readonly description: string }) => Promise<ReviewDecision>;

/** 询问人工审核：缺省/未注入回调 → reject（安全默认，防命令未经确认执行）。 */
export async function askReviewDecision(
  onReviewRequired: OnReviewRequired | undefined,
  nodeId: string,
  description: string,
): Promise<ReviewDecision> {
  return (await onReviewRequired?.({ nodeId, description })) ?? "reject";
}
