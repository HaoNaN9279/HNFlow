// 幂等键注册（v0.2.5 T2）：Engine.runFrom 启动时、persist("running") 之前按 workflowId+idempotencyKey
// 原子注册本次运行；store 拒绝（同键已存在）即抛 IdempotencyKeyConflictError，阻止第二次执行。
import type { RunStateStoreLike } from "../db/stores/types.js";
import type { RunState } from "../runstate/types.js";
import { IdempotencyKeyConflictError } from "./errors.js";

/** 原子注册幂等运行：store.createIfAbsent 返回 false 视为重复提交（同 workflowId+idempotencyKey 已运行）。
 *  判重键 = workflowId + idempotencyKey，绝不按 runId（恢复路径 resumeRun/debugResume/resumeTask
 *  复用 runId 建引擎且不携带幂等键，天然豁免不误伤）。 */
export async function registerIdempotencyKey(store: RunStateStoreLike, runState: RunState): Promise<void> {
  if (runState.idempotencyKey === undefined) return;
  const inserted = await store.createIfAbsent(runState);
  if (!inserted) throw new IdempotencyKeyConflictError(runState.workflowId, runState.idempotencyKey);
}
