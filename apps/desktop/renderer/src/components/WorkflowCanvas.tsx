// WorkflowCanvas：画布容器 + X6 Graph 挂载 + 空状态提示。
//
// - 图创建/插件 5 件套注册/渲染同步集中在 useWorkflowGraph（被本组件调用）；
// - 画布基础事件 → EditorState：选中/取消选中/拖拽位移在此转 dispatch；
// - 连线/删边/删点等特征事件由 T6/T7 用 useWorkflowGraphContext() 拿图实例后自行监听，
//   本文件与 useWorkflowGraph 保持稳定，不被 Wave 3 任务修改；
// - 撤销/重做方法导出（T10 工具栏消费）：见 workflowUndo/workflowRedo。

import { useMemo, useRef } from "react";
import { useEditor, editorActions } from "../editor/state.js";
import {
  useWorkflowGraph,
  useWorkflowGraphContext,
  type WorkflowGraphCallbacks,
} from "../editor/useWorkflowGraph.js";
import { useEdgeConnect } from "../editor/useEdgeConnect.js";

/** 撤销一次画布变更（T10 接工具栏「撤销」）。 */
export { graphUndo as workflowUndo, graphRedo as workflowRedo } from "../editor/useWorkflowGraph.js";

export default function WorkflowCanvas() {
  const { state, dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const containerRef = useRef<HTMLDivElement>(null);

  const callbacks = useMemo<WorkflowGraphCallbacks>(
    () => ({
      onNodeSelected: (nodeId) => dispatch(editorActions.selectNode(nodeId)),
      onSelectionCleared: () => dispatch(editorActions.selectNode(undefined)),
      onNodeMoved: (nodeId, position) => dispatch(editorActions.updateNodePosition(nodeId, position)),
    }),
    [dispatch],
  );

  useWorkflowGraph(state.graph, callbacks, { containerRef, graphRef }, dispatch);
  useEdgeConnect();

  const empty = state.graph.nodes.length === 0;

  return (
    <div className="canvas-wrap">
      <div id="workflow-canvas" ref={containerRef} className="canvas-host" />
      {empty && <div className="canvas-empty">拖拽左侧物料到画布</div>}
    </div>
  );
}
