// T5 最小闭环示例数据：3 节点线性 workflow（start → llm → end）。
// 经 @core toEditorGraph 转成 EditorGraph 作为 renderer 初始画布，
// 验证 useWorkflowGraph 桥的节点/边/端口渲染、选中高亮、拖拽位移回写路径。
// 此示例为演示/联调数据：T11 打开文件后由 setGraph 整体替换。

import { toEditorGraph } from "@core/editing/editor-graph";
import type { EditorGraph } from "@core/editing/editor-graph";
import type { Workflow } from "@core/model/types";

/** 示例工作流（线性无环、端口类型兼容，通过 validateWorkflow 校验）。 */
const EXAMPLE_WORKFLOW: Workflow = {
  id: "example-workflow",
  name: "示例工作流",
  version: "0.4.0",
  nodes: [
    {
      id: "start-1",
      type: "start",
      name: "开始",
      params: {},
      inputs: [],
      outputs: [{ id: "out", name: "启动", type: "any", direction: "out" }],
      position: { x: 40, y: 140 },
    },
    {
      id: "llm-1",
      type: "llm",
      name: "LLM 生成",
      params: { model: "gpt-4o-mini" },
      inputs: [{ id: "in", name: "输入", type: "any", direction: "in" }],
      outputs: [{ id: "out", name: "结果", type: "string", direction: "out" }],
      position: { x: 300, y: 140 },
    },
    {
      id: "end-1",
      type: "end",
      name: "结束",
      params: {},
      inputs: [{ id: "in", name: "入参", type: "any", direction: "in" }],
      outputs: [],
      position: { x: 560, y: 140 },
    },
  ],
  edges: [
    { id: "edge-1", sourceNodeId: "start-1", sourcePortId: "out", targetNodeId: "llm-1", targetPortId: "in" },
    { id: "edge-2", sourceNodeId: "llm-1", sourcePortId: "out", targetNodeId: "end-1", targetPortId: "in" },
  ],
};

/** 示例 EditorGraph（模块加载时由 toEditorGraph 生成，共享不可变引用）。 */
export const exampleEditorGraph: EditorGraph = toEditorGraph(EXAMPLE_WORKFLOW);
