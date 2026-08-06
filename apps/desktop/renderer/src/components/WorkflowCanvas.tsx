// WorkflowCanvas：画布容器 + X6 Graph 挂载 + 空状态提示。
//
// - 图创建/插件 5 件套注册/渲染同步集中在 useWorkflowGraph（被本组件调用）；
// - 画布基础事件 → EditorState：选中/取消选中/拖拽位移在此转 dispatch；
// - 连线/删边/删点等特征事件由 T6/T7 用 useWorkflowGraphContext() 拿图实例后自行监听，
//   本文件与 useWorkflowGraph 保持稳定，不被 Wave 3 任务修改；
// - 撤销/重做方法导出（T10 工具栏消费）：见 workflowUndo/workflowRedo。
// - v0.4.1：只读模式（模板引用子图）→ useReadOnlyMode 禁 X6 交互 + 顶部提示条
//   （提示条 pointer-events: none，不遮挡画布平移/缩放交互）。
// - v0.4.1：画布工具浮层（搜索定位 + 全部折叠/展开）挂载于画布容器内（zIndex 30 顶部，
//   高于 MiniMap z20 / 只读条 z10；pointer-events 放行空白区域，见 CanvasToolsOverlay）。

import { useMemo, useRef, type CSSProperties } from "react";
import { useEditor, editorActions } from "../editor/state.js";
import {
  useWorkflowGraph,
  useWorkflowGraphContext,
  type WorkflowGraphCallbacks,
} from "../editor/useWorkflowGraph.js";
import { useEdgeConnect } from "../editor/useEdgeConnect.js";
import { useNodeUi } from "../editor/ui-context.js";
import { useReadOnlyMode } from "../hooks/useReadOnlyMode.js";
import { CanvasToolsOverlay } from "./CanvasToolsOverlay.js";

/** 撤销一次画布变更（T10 接工具栏「撤销」）。 */
export { graphUndo as workflowUndo, graphRedo as workflowRedo } from "../editor/useWorkflowGraph.js";

/** 只读提示条样式：绝对定位顶部居中，pointer-events 放行给下层画布（平移/缩放不中断）。 */
const readOnlyBannerStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10,
  padding: "4px 12px",
  borderRadius: 4,
  background: "#fffbe6",
  border: "1px solid #ffe58f",
  color: "#ad6800",
  fontSize: 12,
  pointerEvents: "none",
  userSelect: "none",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};

/** MiniMap 容器：右下角常驻（StrictMode 双挂载不销毁，MiniMap 随 Graph 生命周期重建）；半透明背景 + 高 zIndex。 */
const miniMapStyle: CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 12,
  zIndex: 20,
  padding: 4,
  borderRadius: 4,
  background: "rgba(255,255,255,0.85)",
  border: "1px solid rgba(0,0,0,0.1)",
  boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
  overflow: "hidden",
};

export default function WorkflowCanvas() {
  const { state, dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const miniMapRef = useRef<HTMLDivElement>(null);
  const { readOnly } = useNodeUi();

  const callbacks = useMemo<WorkflowGraphCallbacks>(
    () => ({
      onNodeSelected: (nodeId) => dispatch(editorActions.selectNode(nodeId)),
      onSelectionCleared: () => dispatch(editorActions.selectNode(undefined)),
      onNodeMoved: (nodeId, position) => dispatch(editorActions.updateNodePosition(nodeId, position)),
    }),
    [dispatch],
  );

  useWorkflowGraph(state.graph, callbacks, { containerRef, graphRef, miniMapContainerRef: miniMapRef }, dispatch);
  useEdgeConnect();
  // 只读交互控制：须在 useEdgeConnect 之后调用（右键删边回滚 handler 依赖晚注册，见 useReadOnlyMode 注释）。
  useReadOnlyMode();

  const empty = state.graph.nodes.length === 0;

  return (
    <div className="canvas-wrap">
      <div id="workflow-canvas" ref={containerRef} className="canvas-host" />
      <CanvasToolsOverlay />
      <div ref={miniMapRef} style={miniMapStyle} />
      {readOnly && <div style={readOnlyBannerStyle}>模板引用（只读）——如需修改请「保存为新版本」</div>}
      {empty && <div className="canvas-empty">拖拽左侧物料到画布</div>}
    </div>
  );
}
