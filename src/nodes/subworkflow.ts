// 子工作流节点：嵌套执行子图。
// 动态输入端口（packageSubgraph 生成，binding 为 workflow:params:<key>）收集父图参数 →
// 子引擎 workflowVariables（params 整包 + 单键展开）；成功取子图 endResult 返回 out；
// 失败抛 SubworkflowFailedError；挂起抛 SubworkflowWaitingError（父引擎透传，复用子图已建任务）。
import { ExecutionEngine, SubworkflowWaitingError } from "../execution/Engine.js";
import type { INodeDefinition } from "../execution/types.js";
import { validateWorkflow } from "../model/validate.js";
import { isWorkflow } from "../subgraph/shared.js";
import { registry } from "./registry.js";

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

export const subworkflowNode: INodeDefinition = {
  type: "subworkflow",
  name: "子工作流",
  inputs: [],
  outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  async execute(ctx) {
    const raw = ctx.node.params["subworkflow"];
    if (!isWorkflow(raw)) {
      throw new InvalidSubworkflowParamsError(
        "invalid subworkflow params: expected { subworkflow: Workflow }",
      );
    }
    const validated = validateWorkflow(raw);
    if (!validated.ok) {
      throw new InvalidSubworkflowParamsError(`invalid subworkflow: ${validated.errors.join("; ")}`);
    }
    // 深度限制：当前 workflowId 冒号分段数即嵌套深度，≥ 上限抛错。
    const depth = ctx.workflowId.split(":").length;
    if (depth >= MAX_SUBWORKFLOW_DEPTH) {
      throw new SubworkflowDepthError(depth);
    }
    // 收集父图传入参数：输入端口 binding "workflow:params:<key>" → 值。
    const paramsRecord: Record<string, unknown> = {};
    for (const port of ctx.node.inputs) {
      if (port.binding === undefined) continue;
      if (!port.binding.startsWith("workflow:params:")) continue;
      paramsRecord[port.binding.slice("workflow:params:".length)] = ctx.getByPath(port.binding);
    }
    // 子引擎 workflow 变量：params 整包 + 单键展开（子图可读 workflow:params:<key>）+ 父挂起产物透传。
    const workflowVariables: Record<string, unknown> = { params: paramsRecord };
    for (const [key, value] of Object.entries(paramsRecord)) {
      workflowVariables[`params:${key}`] = value;
    }
    for (const [key, value] of Object.entries(ctx.getAll("workflow"))) {
      if (key.startsWith("task_result:")) {
        workflowVariables[key] = value;
      }
    }
    // 子引擎 workflowId 带路径：已是路径（含 :）则继承，否则 父id:子节点id（humanTask 任务定位用）。
    const subWorkflowId = raw.id.includes(":") ? raw.id : `${ctx.workflowId}:${ctx.node.id}`;
    const subEngine = new ExecutionEngine({ ...raw, id: subWorkflowId }, {
      registry,
      workflowVariables,
      ...(ctx.humanTaskStore === undefined ? {} : { humanTaskStore: ctx.humanTaskStore }),
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
    const endResult = subEngine.getWorkflowVariable("endResult");
    return endResult === undefined ? { out: undefined } : { out: endResult };
  },
};
