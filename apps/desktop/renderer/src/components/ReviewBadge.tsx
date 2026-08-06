// 命令节点「待审核」角标（v0.4.2 验收 2）。
// - 显示逻辑：节点 params.reviewRequired === true 时右上角显示「待审核」标记；
// - 挂载：graph-elements.tsx 通用节点卡片（command 节点走通用渲染，非 subworkflow）；
// - 样式：绝对定位卡片右上角外侧（同 VersionBadge 先例），橙色警示色调；
// - 仅展示，不参与交互（pointer-events 放行给卡片）。

import type { CSSProperties } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";

interface ReviewBadgeProps {
  readonly node: EditorGraphNode;
}

/** 待审核角标样式：卡片右上角外侧，橙色警示色。 */
const badgeStyle: CSSProperties = {
  position: "absolute",
  top: -7,
  right: 4,
  zIndex: 5,
  display: "inline-flex",
  alignItems: "center",
  fontSize: 10,
  lineHeight: 1,
  padding: "2px 5px",
  borderRadius: 4,
  border: "1px solid #ffd591",
  background: "#fff7e6",
  color: "#d46b08",
  boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
  pointerEvents: "none",
  userSelect: "none",
};

/** 待审核角标：仅 reviewRequired === true 的节点显示。 */
export function ReviewBadge({ node }: ReviewBadgeProps): JSX.Element | null {
  if (node.params["reviewRequired"] !== true) {
    return null;
  }
  return (
    <span style={badgeStyle} title="该节点命令执行前需人工审核">
      待审核
    </span>
  );
}
