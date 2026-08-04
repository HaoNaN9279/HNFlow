// 异常捕获节点：嵌套执行 try 体子图，成功走 out 分支；失败吞错走 catch 分支；挂起透传父引擎。
// 依赖 engine-util 的互斥机制：tryCatch 未输出端口（值为 undefined）的入边不激活 → 下游 Skipped。
import type { INodeDefinition } from "../execution/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { runSubgraph, SubworkflowWaitingError } from "./subgraph-exec.js";

/** params.body 缺失或形状非法（非 Workflow）。 */
export class InvalidTryCatchParamsError extends Error {
  readonly name = "InvalidTryCatchParamsError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 捕获错误转 catch 端口值：message 必填；错误对象可序列化（无循环引用等）时附 detail。 */
function toCatchValue(err: unknown): { message: string; detail?: unknown } {
  const message = err instanceof Error ? err.message : String(err);
  try {
    JSON.stringify(err);
    return { message, detail: err };
  } catch {
    return { message };
  }
}

export const tryCatchNode: INodeDefinition = {
  type: "tryCatch",
  name: "异常捕获",
  inputs: [],
  outputs: [
    { id: "out", name: "结果", type: "any", direction: "out" },
    { id: "catch", name: "错误", type: "any", direction: "out" },
  ],
  async execute(ctx) {
    const raw = ctx.node.params["body"];
    if (!isWorkflow(raw)) {
      throw new InvalidTryCatchParamsError(
        "invalid tryCatch params: expected { body: Workflow }",
      );
    }
    // 子引擎 workflow 变量：params 整包（子图可读 workflow:params:body）+ 父挂起产物透传（照 subworkflow.ts 模式）。
    const workflowVariables: Record<string, unknown> = { params: ctx.node.params };
    for (const [key, value] of Object.entries(ctx.getAll("workflow"))) {
      if (key.startsWith("task_result:")) {
        workflowVariables[key] = value;
      }
    }
    try {
      const { endResult } = await runSubgraph(ctx, raw, workflowVariables, ctx.registry);
      return { out: endResult, catch: undefined };
    } catch (err) {
      // 挂起不是失败：透传父引擎（复用子图已创建任务，不吞）。
      if (err instanceof SubworkflowWaitingError) throw err;
      // 其余错误（含 SubworkflowFailedError 及任意异常）吞掉：转 catch 端口值，节点本身 Success。
      return { out: undefined, catch: toCatchValue(err) };
    }
  },
};
