// 开始节点：工作流入口。将全局变量快照注入 workflow:start 数据流。

import type { INodeDefinition } from "../execution/types.js";

export const startNode: INodeDefinition = {
  type: "start",
  name: "开始",
  inputs: [],
  outputs: [
    {
      id: "data",
      name: "data",
      type: "any",
      direction: "out",
      binding: "workflow:start",
    },
  ],
  async execute(ctx) {
    return { data: ctx.getAll("global") };
  },
};
