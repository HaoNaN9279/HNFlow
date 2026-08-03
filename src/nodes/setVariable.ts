// 变量赋值节点：将 params.value（支持 ${scope:key} 插值）写入 params.target 路径。

import type { INodeDefinition, NodeExecutionContext } from "../execution/types.js";

/** setVariable 节点缺少或格式错误的 target 参数 */
export class InvalidSetVariableParameterError extends Error {
  readonly name = "InvalidSetVariableParameterError";

  constructor() {
    super("invalid setVariable params: expected { target, value }");
  }
}

const INTERPOLATION_PATTERN = /\$\{([^}]+)\}/g;

function resolveInterpolation(template: string, ctx: NodeExecutionContext): string {
  return template.replace(INTERPOLATION_PATTERN, (_, path: string) => {
    const raw = ctx.getByPath(path);
    return raw === undefined ? "" : String(raw);
  });
}

function parseTarget(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const setVariableNode: INodeDefinition = {
  type: "setVariable",
  name: "变量赋值",
  inputs: [],
  outputs: [],
  async execute(ctx) {
    const target = parseTarget(ctx.node.params["target"]);
    if (target === undefined) {
      throw new InvalidSetVariableParameterError();
    }
    const raw = ctx.node.params["value"];
    const resolved = typeof raw === "string" ? resolveInterpolation(raw, ctx) : raw;
    ctx.setByPath(target, resolved);
    return {};
  },
};
