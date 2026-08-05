// 子工作流节点：嵌套执行子图（内嵌对象或模板引用）。
// 模板引用（v0.3.3 T2）：params.template（"name@version"）→ loadTemplateWorkflow 加载模板库工作流 → 走与内嵌相同的 runSubgraph 流程；
// 动态输入端口（packageSubgraph 生成，binding 为 workflow:params:<key>）收集父图参数 → 子引擎执行（校验/深度限制/挂起透传见 subgraph-exec.ts）；成功取子图 endResult 返回 out。
import type { INodeDefinition } from "../execution/types.js";
import type { Workflow } from "../model/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { loadTemplateWorkflow } from "../templates/load-template-workflow.js";
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
    // 模板引用优先：params.template 存在走模板加载，缺省走内嵌 params.subworkflow。
    const templateRef = ctx.node.params["template"];
    let subworkflow: Workflow;
    if (templateRef === undefined) {
      const raw = ctx.node.params["subworkflow"];
      if (!isWorkflow(raw)) {
        throw new InvalidSubworkflowParamsError(
          "invalid subworkflow params: expected { subworkflow: Workflow }",
        );
      }
      subworkflow = raw;
    } else {
      if (typeof templateRef !== "string") {
        throw new InvalidSubworkflowParamsError(
          "invalid subworkflow params: template 引用必须是字符串（格式 name@version）",
        );
      }
      // 模板缺失/版本缺失/引用非法：loadTemplateWorkflow 抛错（消息含引用值），节点 Failed 时错误含引用。
      subworkflow = await loadTemplateWorkflow(ctx.templatesRootDir ?? "./templates", templateRef);
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
    const { endResult } = await runSubgraph(ctx, subworkflow, workflowVariables, ctx.registry);
    return { out: endResult };
  },
};
