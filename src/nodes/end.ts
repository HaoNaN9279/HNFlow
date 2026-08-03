// 结束节点：工作流出口。读取 workflow:endInput 并写入 workflow:endResult。

import type { INodeDefinition } from "../execution/types.js";

export const endNode: INodeDefinition = {
  type: "end",
  name: "结束",
  inputs: [
    {
      id: "in",
      name: "data",
      type: "any",
      direction: "in",
      binding: "workflow:endInput",
    },
  ],
  outputs: [],
  async execute(ctx) {
    const value = ctx.getByPath("workflow:endInput");
    const resolved = value === undefined ? ctx.get("workflow", "endInput") : value;
    ctx.setByPath("workflow:endResult", resolved);
    return {};
  },
};
