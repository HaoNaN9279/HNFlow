// 子图执行公共 helper：校验 → 深度限制 → 子引擎执行 → 结果转换。
// 供 subworkflow 节点及未来其他子图执行方复用；参数收集由各调用方负责（runSubgraph 只接收已组好的 workflowVariables）。
// 调试透传（v0.2.4 T3）：子引擎复用父 DebugController（enterSubgraph/exitSubgraph 深度计数），子图 paused 抛 SubworkflowPausedError 冒泡。
import { ExecutionEngine, SubworkflowPausedError, SubworkflowWaitingError } from "../execution/Engine.js";
import type { NodeExecutionContext } from "../execution/types.js";
import { validateWorkflow } from "../model/validate.js";
import type { Workflow } from "../model/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { registry } from "./registry.js";
import type { NodeRegistry } from "./registry.js";

/** 子工作流嵌套深度上限：workflowId 冒号分段数 ≥ 该值抛 SubworkflowDepthError（最大允许 9 层）。 */
export const MAX_SUBWORKFLOW_DEPTH = 10;

/** params.subworkflow 缺失、形状非法或子图校验失败。 */
export class InvalidSubworkflowParamsError extends Error {
  readonly name = "InvalidSubworkflowParamsError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 子图执行失败（携带子引擎错误消息）。 */
export class SubworkflowFailedError extends Error {
  readonly name = "SubworkflowFailedError";

  constructor(readonly detail: string) {
    super(`子工作流执行失败: ${detail}`);
  }
}

/** 子工作流嵌套深度超限（workflowId 冒号分段数 ≥ MAX_SUBWORKFLOW_DEPTH）。 */
export class SubworkflowDepthError extends Error {
  readonly name = "SubworkflowDepthError";

  constructor(readonly depth: number) {
    super(`子工作流嵌套深度超限: 当前 ${depth} 层（最大 ${MAX_SUBWORKFLOW_DEPTH - 1} 层）`);
  }
}

/** 子图挂起信号：由子引擎抛出，父引擎透传（复用子图已创建任务，不重复创建）。 */
export { SubworkflowWaitingError };

/** 子图暂停信号：由子引擎（断点/单步 paused）抛出，父引擎透传（容器转 Paused，pendingNodeId=子图首节点，workflowId 链还原调用栈）。 */
export { SubworkflowPausedError };

/** 子图执行公共校验：形状/语义检查 → 深度限制，非法直接抛错（runSubgraph 与 runBranch 共用）。 */
function assertSubworkflowExecutable(ctx: NodeExecutionContext, subworkflow: Workflow): void {
  if (!isWorkflow(subworkflow)) {
    throw new InvalidSubworkflowParamsError(
      "invalid subworkflow params: expected { subworkflow: Workflow }",
    );
  }
  const validated = validateWorkflow(subworkflow);
  if (!validated.ok) {
    throw new InvalidSubworkflowParamsError(`invalid subworkflow: ${validated.errors.join("; ")}`);
  }
  // 深度限制：当前 workflowId 冒号分段数即嵌套深度，≥ 上限抛错。
  const depth = ctx.workflowId.split(":").length;
  if (depth >= MAX_SUBWORKFLOW_DEPTH) {
    throw new SubworkflowDepthError(depth);
  }
}

/**
 * 子引擎执行公共流程：构造子引擎（复用父调试控制器 + 深度计数）→ run → 结果转换。
 * success 返回 { endResult, variables }；failed 抛 SubworkflowFailedError；
 * waiting 抛 SubworkflowWaitingError（含子图已创建任务）；paused 抛 SubworkflowPausedError（pendingNodeId=子图首节点）。
 */
async function executeSubEngine(
  ctx: NodeExecutionContext,
  subworkflow: Workflow,
  subWorkflowId: string,
  subRegistry: NodeRegistry,
  workflowVariables: Record<string, unknown>,
): Promise<{ readonly endResult: unknown; readonly variables: Record<string, unknown> }> {
  const debug = ctx.debugController;
  debug?.enterSubgraph();
  try {
    const subEngine = new ExecutionEngine({ ...subworkflow, id: subWorkflowId }, {
      registry: subRegistry,
      workflowVariables,
      ...(ctx.humanTaskStore === undefined ? {} : { humanTaskStore: ctx.humanTaskStore }),
      ...(debug === undefined ? {} : { debugController: debug }),
    });
    const subResult = await subEngine.run();
    if (subResult.status === "failed") {
      throw new SubworkflowFailedError(subResult.error ?? "unknown error");
    }
    if (subResult.status === "waiting") {
      const task = subResult.waitingTask;
      if (task === undefined) {
        throw new SubworkflowFailedError("子图挂起但缺少任务记录");
      }
      throw new SubworkflowWaitingError(task);
    }
    if (subResult.status === "paused") {
      const pendingNodeId = subResult.pendingNodeId;
      if (pendingNodeId === undefined) {
        throw new SubworkflowFailedError("子图暂停但缺少暂停节点");
      }
      throw new SubworkflowPausedError(pendingNodeId, subWorkflowId);
    }
    return { endResult: subEngine.getWorkflowVariable("endResult"), variables: subEngine.getWorkflowVariables() };
  } finally {
    debug?.exitSubgraph();
  }
}

/**
 * 子图执行公共流程：形状/语义校验 → 深度限制 → 子引擎执行 → 结果转换。
 * success 返回 { endResult: value | undefined }（输出端口映射由调用方决定）；
 * failed 抛 SubworkflowFailedError；waiting 抛 SubworkflowWaitingError（含子图已创建任务）；paused 抛 SubworkflowPausedError。
 */
export async function runSubgraph(
  ctx: NodeExecutionContext,
  subworkflow: Workflow,
  workflowVariables: Record<string, unknown>,
  registryOverride?: NodeRegistry,
): Promise<Record<string, unknown>> {
  assertSubworkflowExecutable(ctx, subworkflow);
  // 子引擎 workflowId 带路径：已是路径（含 :）则继承，否则 父id:子节点id（humanTask 任务定位用）。
  const subWorkflowId = subworkflow.id.includes(":") ? subworkflow.id : `${ctx.workflowId}:${ctx.node.id}`;
  // 子引擎 registry：优先用容器节点透传的 registry（自定义节点测试/扩展），缺省默认内置 registry。
  const subRegistry = registryOverride ?? registry;
  const { endResult } = await executeSubEngine(ctx, subworkflow, subWorkflowId, subRegistry, workflowVariables);
  return { endResult };
}

/**
 * 并行分支执行：与 runSubgraph 同构（校验 → 深度限制 → 子引擎执行 → 结果转换），
 * 额外返回 workflow 作用域全量变量拷贝供并行节点合并 diff，并支持 idSuffix 隔离分支 workflowId
 * （避免并行多分支共用 workflowId 串 humanTask 任务定位 findPending(workflowId, nodeId)）。
 * success 返回 { endResult, variables }；failed 抛 SubworkflowFailedError；waiting 抛 SubworkflowWaitingError；paused 抛 SubworkflowPausedError。
 */
export async function runBranch(
  ctx: NodeExecutionContext,
  subworkflow: Workflow,
  workflowVariables: Record<string, unknown>,
  registryOverride?: NodeRegistry,
  idSuffix?: string,
): Promise<{ endResult: unknown; variables: Record<string, unknown> }> {
  assertSubworkflowExecutable(ctx, subworkflow);
  // 分支 workflowId：已是路径（含 :）则继承，否则 父id:子节点id + 分支标识（humanTask 任务定位隔离用）。
  const subWorkflowId = subworkflow.id.includes(":") ? subworkflow.id : `${ctx.workflowId}:${ctx.node.id}${idSuffix ?? ""}`;
  const subRegistry = registryOverride ?? registry;
  return executeSubEngine(ctx, subworkflow, subWorkflowId, subRegistry, workflowVariables);
}
