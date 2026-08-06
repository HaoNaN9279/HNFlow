// 子工作流节点渲染（T9）：type === "subworkflow" 的专用卡片。
//
// - 折叠态（默认）：显示摘要「子工作流（N 节点 / M 连线）」；
// - 展开态：原位展示内嵌子图节点链（A → B → C）+「双击进入编辑」提示；
// - 双击卡片 → enterSubworkflow（进入内部编辑层，dispatch pushLevel + setGraph 子图）；
// - 折叠/展开为本地 UI 状态（useState），不入 EditorState（保持契约精简）；
// - 样式复用 global.css 既有卡片类；新增 toggle 按钮用内联样式，避免跨分区改样式文件。
//
// 挂载：graph-elements.tsx 的通用节点渲染按 data.type 分发，subworkflow 类型委托本组件。

import { useState, type CSSProperties } from "react";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type { Node } from "@antv/x6";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { useEditStack } from "../hooks/useEditStack.js";

interface SubworkflowNodeProps {
  /** X6 节点（data 为 EditorGraphNode，type === "subworkflow"）。 */
  readonly node: Node;
}

/** 展开/折叠按钮样式（不占 global.css 分区，内联保隔离）。 */
const toggleStyle: CSSProperties = {
  alignSelf: "flex-start",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 6px",
  border: "1px solid #91caff",
  borderRadius: 4,
  background: "#f5fbff",
  color: "#1677ff",
  fontSize: 11,
  lineHeight: 1.4,
  cursor: "pointer",
};

/** 提示行样式：单行省略，防内嵌节点链撑破卡片。 */
const tipStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** 子工作流节点卡片：折叠摘要 / 展开子图节点链 / 双击进入编辑层。 */
export function SubworkflowNode({ node }: SubworkflowNodeProps) {
  const data = node.getData<EditorGraphNode | undefined>();
  const { enterSubworkflow } = useEditStack();
  const [expanded, setExpanded] = useState(false);

  if (data === undefined || data.subworkflow === undefined) {
    return <div className="hnflow-node-card hnflow-node-card-subworkflow">（子工作流数据缺失）</div>;
  }

  const { subworkflow } = data;
  const summary = `子工作流（${subworkflow.nodes.length} 节点 / ${subworkflow.edges.length} 连线）`;
  const innerChain = subworkflow.nodes.map((n) => n.name).join(" → ");

  return (
    <div
      className="hnflow-node-card hnflow-node-card-subworkflow"
      title={data.name}
      onDoubleClick={(event) => {
        event.stopPropagation();
        enterSubworkflow(data);
      }}
    >
      <div className="hnflow-node-title">{data.name}</div>
      <span className="hnflow-node-badge">subworkflow</span>
      <button
        type="button"
        style={toggleStyle}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((v) => !v);
        }}
      >
        {expanded ? <DownOutlined /> : <RightOutlined />}
        {expanded ? "收起摘要" : "展开摘要"}
      </button>
      <div className="hnflow-node-tip" style={tipStyle}>
        {expanded ? `${innerChain} · 双击进入编辑` : summary}
      </div>
    </div>
  );
}
