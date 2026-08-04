// 子工作流节点：嵌套执行子图。
// 动态输入端口（packageSubgraph 生成，binding 为 workflow:params:<key>）收集父图参数 →
// runSubgraph 执行子引擎（校验/深度限制/挂起透传见 subgraph-exec.ts）；成功取子图 endResult 返回 out。
import type { INodeDefinition } from "../execution/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { InvalidSubworkflowParamsError, runSubgraph } from "./subgraph-exec.js";

// 错误类型/深度常量 re-export：定义已移至 subgraph-exec.ts，本文件保留导出避免破坏既有 import 链。
export {
  InvalidSubworkflowParamsError,
  MAX_SUBWORKFLOW_DEPTH,
  SubworkflowDepthError,
  SubworkflowFailedError,
  SubworkflowWaitingError,
} from "./subgraph-exec.js";

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
    const { endResult } = await runSubgraph(ctx, raw, workflowVariables);
    return { out: endResult };
  },
};
