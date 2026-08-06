// CanvasToolsOverlay：画布级「搜索定位 + 全部折叠/展开」浮层（v0.4.1）。
//
// - 搜索：数据源 useEditor() 当前层 state.graph.nodes（id/type/name），模糊匹配（不区分大小写），
//   下拉展示「name（type）」；选中 → graph.centerCell 定位（scale < 0.5 时 zoomToFit 放大查看）
//   → graph.select 选中画布节点 → dispatch selectNode 同步 EditorState（ConfigPanel 联动）；
// - 全部折叠/展开：遍历 graph.getNodes() 过滤 data.type === "subworkflow" → setProp("collapsed", v,
//   { history: false })（UI 状态不入 undo 栈；ReactShape 重渲染机制见 SubworkflowNode 文件头注释）；
// - 空状态（无 subworkflow 节点）：按钮禁用 + Tooltip 提示；
// - 样式：absolute 画布顶部居中、zIndex 30（高于 MiniMap z20 / 只读条 z10）；容器 pointer-events
//   none 放行画布空白交互，仅自身交互元素 pointer-events auto；内联样式（不碰 global.css）。

import { useMemo, useState, type CSSProperties } from "react";
import { AutoComplete, Button, Space, Tooltip, message } from "antd";
import { DownOutlined, UpOutlined } from "@ant-design/icons";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { useWorkflowGraphContext } from "../editor/useWorkflowGraph.js";
import { editorActions, useEditor } from "../editor/state.js";

/** 浮层容器：顶部居中，pointer-events none（自身元素 auto），不拦截画布平移/缩放。 */
const overlayStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  gap: 8,
  pointerEvents: "none",
};

/** 交互控件容器：恢复可点击（搜索框/按钮）。 */
const interactiveStyle: CSSProperties = { pointerEvents: "auto" };

/** 画布搜索 + 折叠控制浮层（挂载于 WorkflowCanvas 画布容器内）。 */
export function CanvasToolsOverlay(): JSX.Element {
  const { state, dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const [keywordInput, setKeywordInput] = useState("");
  const nodes = state.graph.nodes;

  /** 子工作流节点数量（当前层）：空状态时禁用折叠按钮。 */
  const subworkflowCount = useMemo(() => nodes.filter((n) => n.type === "subworkflow").length, [nodes]);

  /** 模糊匹配下拉选项：关键字匹配 name / type / id（不区分大小写）。 */
  const options = useMemo(() => {
    const keyword = keywordInput.trim().toLowerCase();
    if (keyword === "") {
      return [];
    }
    return nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(keyword) ||
          n.type.toLowerCase().includes(keyword) ||
          n.id.toLowerCase().includes(keyword),
      )
      .map((n) => ({ value: n.id, label: `${n.name}（${n.type}）` }));
  }, [keywordInput, nodes]);

  /** 定位并选中节点：centerCell 居中；视图过小（scale < 0.5）时 zoomToFit 放大以便看清。 */
  const handleLocate = (nodeId: string): void => {
    const graph = graphRef.current;
    if (graph === null) {
      return;
    }
    const node = graph.getNodes().find((n) => n.id === nodeId);
    if (node === undefined) {
      message.warning("节点不在当前画布中");
      return;
    }
    graph.centerCell(node);
    if (graph.zoom() < 0.5) {
      graph.zoomToFit({ padding: 100, maxScale: 1.2 });
    }
    graph.select(node);
    dispatch(editorActions.selectNode(nodeId));
  };

  /** 画布级折叠/展开：全部 subworkflow 节点统一 setProp（history: false，不入 undo 栈）。 */
  const applyCollapse = (collapsed: boolean): void => {
    const graph = graphRef.current;
    if (graph === null) {
      return;
    }
    const targets = graph.getNodes().filter((n) => n.getData<EditorGraphNode | undefined>()?.type === "subworkflow");
    if (targets.length === 0) {
      message.info("当前画布没有子工作流节点");
      return;
    }
    for (const node of targets) {
      node.setProp("collapsed", collapsed, { history: false });
    }
    message.success(collapsed ? `已折叠 ${targets.length} 个子工作流` : `已展开 ${targets.length} 个子工作流`);
  };

  return (
    <div style={overlayStyle}>
      <AutoComplete
        style={{ width: 240, ...interactiveStyle }}
        value={keywordInput}
        onChange={setKeywordInput}
        onSelect={handleLocate}
        options={options}
        placeholder="搜索节点（名称/类型/id）"
        allowClear
      />
      <div style={interactiveStyle}>
        <Space>
          <Tooltip title={subworkflowCount === 0 ? "当前没有子工作流节点" : "全部折叠"}>
            <Button size="small" icon={<DownOutlined />} disabled={subworkflowCount === 0} onClick={() => applyCollapse(true)}>
              全部折叠
            </Button>
          </Tooltip>
          <Tooltip title={subworkflowCount === 0 ? "当前没有子工作流节点" : "全部展开"}>
            <Button size="small" icon={<UpOutlined />} disabled={subworkflowCount === 0} onClick={() => applyCollapse(false)}>
              全部展开
            </Button>
          </Tooltip>
        </Space>
      </div>
    </div>
  );
}
