// 人工节点：无输入端口。首次执行挂起等待人工介入（引擎捕获 suspend 信号）；
// resume 后从 workflow:task_result:<nodeId> 读取人工产物并 Success。

import type { INodeDefinition } from "../execution/types.js";
import type { HumanTaskFallback } from "../human/types.js";

/** humanTask 节点缺少必填 title 或 description/fallback 类型错误 */
export class InvalidHumanTaskParamsError extends Error {
  readonly name = "InvalidHumanTaskParamsError";

  constructor(readonly params: Readonly<Record<string, unknown>>) {
    super("invalid humanTask params: expected { title: string, description?, fallback? }");
  }
}

/** 解析后的人工节点参数 */
interface HumanTaskParams {
  readonly title: string;
  readonly description: string | undefined;
  readonly fallback: HumanTaskFallback | undefined;
}

function isFallback(value: unknown): value is HumanTaskFallback {
  return value === "manual" || value === "skip" || value === "ai" || value === "defer";
}

/** 边界解析：title 必填字符串，description/fallback 可选；存在但类型非法则整体失败 */
function parseParams(params: Readonly<Record<string, unknown>>): HumanTaskParams | undefined {
  const title = params["title"];
  if (typeof title !== "string") {
    return undefined;
  }
  const description = params["description"];
  if (description !== undefined && typeof description !== "string") {
    return undefined;
  }
  const fallback = params["fallback"];
  if (fallback !== undefined && !isFallback(fallback)) {
    return undefined;
  }
  return { title, description, fallback };
}

export const humanTaskNode: INodeDefinition = {
  type: "humanTask",
  name: "人工节点",
  inputs: [],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
  async execute(ctx) {
    const params = parseParams(ctx.node.params);
    if (params === undefined) {
      throw new InvalidHumanTaskParamsError(ctx.node.params);
    }
    if (params.fallback === "ai") {
      throw new Error("AI 代做未实现（v0.2.x 提供）");
    }
    const submitted = ctx.get("workflow", `task_result:${ctx.node.id}`);
    if (submitted === undefined) {
      ctx.suspend({
        title: params.title,
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.fallback === undefined ? {} : { fallback: params.fallback }),
      });
    }
    return { output: submitted };
  },
};
