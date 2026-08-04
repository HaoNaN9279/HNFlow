// 引擎级错误类集中定义（v0.2.5 从 Engine.ts 拆出，控制 Engine 行数上限）：
// 挂起信号 + 幂等键冲突。子图容器（subgraph-exec.ts）从 Engine re-export 消费，本模块不直接面向调用方。
import type { HumanTask, HumanTaskSpec } from "../human/types.js";

/** 节点请求人工介入的信号：由 ctx.suspend 抛出，引擎识别后转入挂起流程（不视为失败）。 */
export class HumanTaskRequiredError extends Error {
  readonly name = "HumanTaskRequiredError";
  constructor(readonly spec: HumanTaskSpec) { super(`human task required: ${spec.title}`); }
}

/** 子工作流挂起信号：由 subworkflow 节点抛出，父引擎透传（复用子图已创建任务，不重复创建）。 */
export class SubworkflowWaitingError extends Error {
  readonly name = "SubworkflowWaitingError";
  constructor(readonly task: HumanTask) { super(`subworkflow waiting for human task: ${task.title}`); }
}

/** 子工作流暂停信号：子引擎断点 paused 透传，父引擎容器转 Paused（pendingNodeId=子图首节点，workflowId 链还原调用栈）。 */
export class SubworkflowPausedError extends Error {
  readonly name = "SubworkflowPausedError";
  constructor(readonly pendingNodeId: string, readonly workflowId: string) { super(`subworkflow paused at node: ${pendingNodeId}`); }
}

/** 幂等键重复提交冲突：同 workflowId + 同 idempotencyKey 已存在运行记录（v0.2.5 T2 判重）。 */
export class IdempotencyKeyConflictError extends Error {
  readonly name = "IdempotencyKeyConflictError";
  constructor(readonly workflowId: string, readonly idempotencyKey: string) {
    super(`idempotency key conflict: workflow "${workflowId}" already ran with key "${idempotencyKey}"`);
  }
}
