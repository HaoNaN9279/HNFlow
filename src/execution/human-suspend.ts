// 人工任务挂起通用流程（v0.2.5 T4）：HumanTaskRequiredError 挂起与崩溃转人工确认共用。
// 查重扩展 findPending(workflowId, nodeId, runId?)：runId 传参时按 (workflowId, nodeId, runId)
// 精确查重（跨 run 同节点不串任务）；不传时保持旧语义（workflowId+nodeId）。
// 独立模块保持 Engine.ts ≤440 行；Engine 私有状态经 SuspendOps 参数化注入，无循环依赖。
import type { HumanTaskStoreLike } from "../db/stores/types.js";
import type { HumanTask, HumanTaskSpec } from "../human/types.js";
import type { Node } from "../model/types.js";

/** 崩溃确认任务 meta.kind（与 ai_interrupt 区分，isAiInterruptTask 不误伤）。 */
export const CRASH_CONFIRM_KIND = "crash_confirm";

/** 挂起操作注入面：Engine 私有状态经此参数化，模块不直接访问 ExecutionEngine。 */
export interface SuspendOps {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly runId: string;
  readonly store: HumanTaskStoreLike;
}

/** 崩溃确认结果（对齐 Engine RunNodeOutcome 的 waiting 分支；failed 由调用方回退原 Failed 路径）。 */
export type CrashConfirmOutcome =
  | { readonly kind: "waiting"; readonly task: HumanTask }
  | { readonly kind: "failed"; readonly message: string };

/** 创建/复用挂起任务：findPending(workflowId, nodeId, runId) 命中复用，否则新建（携带 runId）。 */
export async function suspendToWaiting(ops: SuspendOps, spec: HumanTaskSpec): Promise<HumanTask> {
  const existing = await ops.store.findPending(ops.workflowId, ops.nodeId, ops.runId);
  const task = existing ?? (await ops.store.create({
    workflowId: ops.workflowId,
    runId: ops.runId,
    nodeId: ops.nodeId,
    nodeName: ops.nodeName,
    ...spec,
  }));
  return task;
}

/** 崩溃确认挂起：创建/复用 crash_confirm 任务（title 含失败信息、fallback=manual、meta.kind + runId）。
 *  创建失败（如无 store）返回 failed 结果，调用方回退原 Failed 路径。 */
export async function crashConfirmToWaiting(ops: SuspendOps, errorMessage: string): Promise<CrashConfirmOutcome> {
  try {
    const task = await suspendToWaiting(ops, {
      title: `${ops.nodeName}(${ops.nodeId}) 崩溃确认：${errorMessage}`,
      description: errorMessage,
      fallback: "manual",
      meta: { kind: CRASH_CONFIRM_KIND, error: errorMessage },
    });
    return { kind: "waiting", task };
  } catch (cause) {
    return {
      kind: "failed",
      message: `${ops.nodeName}(${ops.nodeId}) 崩溃转人工失败: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** 判定是否转崩溃确认：idempotencyKey 开启 且 节点静态非幂等标记。 */
export function shouldCrashConfirm(idempotencyKey: string | undefined, idempotent: boolean | undefined): boolean {
  return idempotencyKey !== undefined && idempotent === false;
}

/** 构造 SuspendOps（Engine.suspendOps getter 复用：挂起与崩溃确认共用注入面）。 */
export function makeSuspendOps(workflowId: string, node: Node, runId: string, store: HumanTaskStoreLike): SuspendOps {
  return { workflowId, nodeId: node.id, nodeName: node.name, runId, store };
}
