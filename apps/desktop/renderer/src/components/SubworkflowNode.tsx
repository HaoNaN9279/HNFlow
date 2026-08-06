// 子工作流节点渲染（T9）：type === "subworkflow" 的专用卡片。
//
// - 折叠态（collapsed prop 为 true，画布级「全部折叠」设置）：显示摘要「子工作流（N 节点 / M 连线）」；
// - 展开态：原位展示内嵌子图节点链（A → B → C）+「双击进入编辑」提示；
// - 模板引用（params.template = "name@version"）：子图内容在模板库，无内嵌内容，
//   摘要显示「子工作流（模板引用）」，右上角渲染版本角标（VersionBadge）；
// - 双击卡片 → enterSubworkflow（进入内部编辑层，dispatch pushLevel + setGraph 子图）；
// - 折叠/展开由 X6 节点 prop "collapsed" 驱动（v0.4.1 画布级「全部折叠/展开」统一控制）：
//   组件渲染时直接派生 node.getProp("collapsed")，toggle 经 node.setProp(..., { history: false })
//   不入 undo 栈；@antv/x6-react-shape@2.2.3 的 Wrap 监听 cell "change:*" 事件（未配置 effect
//   过滤）→ setProp 触发 change:collapsed → React 组件原地重渲染，无需本地 state / useEffect 订阅；
// - 样式复用 global.css 既有卡片类；新增 toggle 按钮用内联样式，避免跨分区改样式文件。
//
// 挂载：graph-elements.tsx 的通用节点渲染按 data.type 分发，subworkflow 类型委托本组件。

import { type CSSProperties } from "react";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type { Node } from "@antv/x6";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { useEditStack } from "../hooks/useEditStack.js";
import { VersionBadge } from "./VersionBadge.js";

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
  // 折叠态由 X6 节点 prop 驱动（画布级「全部折叠/展开」统一 setProp，见文件头注释）。
  const collapsed = node.getProp<boolean>("collapsed") ?? false;
  const expanded = !collapsed;

  if (data === undefined) {
    return <div className="hnflow-node-card hnflow-node-card-subworkflow">（子工作流数据缺失）</div>;
  }

  // 模板引用（params.template 为 string）：子图内容在模板库，画布上无内嵌内容，属正常形态（非缺失），
  // 主卡片展示名称 + 版本角标（VersionBadge 内部区分「模板引用/内嵌」两种形态）。
  const embedded = data.subworkflow;
  const summary =
    embedded === undefined
      ? "子工作流（模板引用）"
      : `子工作流（${embedded.nodes.length} 节点 / ${embedded.edges.length} 连线）`;
  const innerChain = embedded === undefined ? "" : embedded.nodes.map((n) => n.name).join(" → ");

  return (
    <div
      className="hnflow-node-card hnflow-node-card-subworkflow"
      style={{ position: "relative" }}
      title={data.name}
      onDoubleClick={(event) => {
        event.stopPropagation();
        void enterSubworkflow(data);
      }}
    >
      <VersionBadge node={data} />
      <div className="hnflow-node-title">{data.name}</div>
      <span className="hnflow-node-badge">subworkflow</span>
      <button
        type="button"
        style={toggleStyle}
        onClick={(event) => {
          event.stopPropagation();
          node.setProp("collapsed", !collapsed, { history: false });
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
