// 收尾清理节点：嵌套执行 finally 体子图，上游终态（含 Failed）激活后执行清理。
// 执行时机由引擎调度控制（engine-util isActiveIncoming 对上游 Failed 且目标 type "finally" 放行）；
// 本节点只负责执行体子图：成功输出 out；体失败直接抛（节点 Failed，主错误由引擎保留）；挂起透传父引擎。
import type { INodeDefinition } from "../execution/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { runSubgraph, SubworkflowWaitingError } from "./subgraph-exec.js";

/** params.body 缺失或形状非法（非 Workflow）。 */
export class InvalidFinallyParamsError extends Error {
  readonly name = "InvalidFinallyParamsError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

export const finallyNode: INodeDefinition = {
  type: "finally",
  name: "收尾清理",
  inputs: [],
  outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  async execute(ctx) {
    const raw = ctx.node.params["body"];
    if (!isWorkflow(raw)) {
      throw new InvalidFinallyParamsError(
        "invalid finally params: expected { body: Workflow }",
      );
    }
    // 子引擎 workflow 变量：params 整包（子图可读 workflow:params:body）+ 父挂起产物透传（照 tryCatch.ts 模式）。
    const workflowVariables: Record<string, unknown> = { params: ctx.node.params };
    for (const [key, value] of Object.entries(ctx.getAll("workflow"))) {
      if (key.startsWith("task_result:")) {
        workflowVariables[key] = value;
      }
    }
    try {
      const { endResult } = await runSubgraph(ctx, raw, workflowVariables, ctx.registry);
      return { out: endResult };
    } catch (err) {
      // 挂起不是失败：透传父引擎（复用子图已创建任务，引擎转 waiting，不吞）。
      if (err instanceof SubworkflowWaitingError) throw err;
      // finally 体失败（SubworkflowFailedError、深度/参数错误、任意异常）= 清理失败：
      // 直接抛出，引擎置本节点 Failed；主错误仍由引擎保留（savedError 首次失败优先）。
      throw err;
    }
  },
};
