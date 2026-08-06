// 通用节点渲染（x6-react-shape）：
// - WorkflowNodeView：React 卡片（名称 + 类型徽标 + 子流程提示），选中高亮走 CSS（.x6-node-selected）；
// - register：注册通用节点形状（模块加载时执行一次，同名注册幂等覆盖）；
// - toX6Node / toX6Edge：@core 节点/边 → X6 元数据（端口配置 + 边样式）。

import { type Edge, type Graph, type Node } from "@antv/x6";
import { register } from "@antv/x6-react-shape";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { Edge as CoreEdge } from "@core/model/types";
import { SubworkflowNode } from "../components/SubworkflowNode.js";
import { toPortCellId } from "./ports.js";

export const NODE_SHAPE = "hnflow-node";
export const NODE_WIDTH = 172;
export const NODE_MIN_HEIGHT = 80;
/** 输入/输出端口组取色（in 蓝、out 绿）。 */
const PORT_COLORS = { in: "#1677ff", out: "#52c41a" } as const;

/** 节点高度随端口数自适应（左侧 in、右侧 out 平分高度，避免标签挤叠）。 */
export function nodeHeight(node: EditorGraphNode): number {
  const maxPorts = Math.max(node.inputs.length, node.outputs.length);
  return Math.max(NODE_MIN_HEIGHT, 48 + maxPorts * 24);
}

/** 端口配置：in 组靠左、out 组靠右；port id = `${nodeId}:${portId}`（T7 依赖）。 */
export function buildPorts(node: EditorGraphNode) {
  return {
    groups: {
      in: {
        position: "left",
        attrs: { circle: { r: 4, magnet: true, stroke: PORT_COLORS.in, strokeWidth: 1.5, fill: "#ffffff" } },
      },
      out: {
        position: "right",
        attrs: { circle: { r: 4, magnet: true, stroke: PORT_COLORS.out, strokeWidth: 1.5, fill: "#ffffff" } },
      },
    },
    items: [
      ...node.inputs.map((port) => ({
        id: toPortCellId(node.id, port.id),
        group: "in" as const,
        attrs: {
          circle: { r: 4, magnet: true, stroke: PORT_COLORS.in, strokeWidth: 1.5, fill: "#ffffff" },
          text: { text: port.name, fontSize: 9, fill: "#8c8c8c" },
        },
        label: { position: "left" as const },
      })),
      ...node.outputs.map((port) => ({
        id: toPortCellId(node.id, port.id),
        group: "out" as const,
        attrs: {
          circle: { r: 4, magnet: true, stroke: PORT_COLORS.out, strokeWidth: 1.5, fill: "#ffffff" },
          text: { text: port.name, fontSize: 9, fill: "#8c8c8c" },
        },
        label: { position: "right" as const },
      })),
    ],
  };
}

/** EditorGraphNode → X6 节点元数据（含端口与位置）。 */
export function toX6Node(node: EditorGraphNode): Node.Metadata {
  return {
    id: node.id,
    shape: NODE_SHAPE,
    x: node.position.x,
    y: node.position.y,
    width: NODE_WIDTH,
    height: nodeHeight(node),
    data: node,
    ports: buildPorts(node),
  };
}

/** @core Edge → X6 边元数据（manhattan 路由 + smooth 连接 + 箭头）。 */
export function toX6Edge(edge: CoreEdge): Edge.Metadata {
  return {
    id: edge.id,
    source: { cell: edge.sourceNodeId, port: toPortCellId(edge.sourceNodeId, edge.sourcePortId) },
    target: { cell: edge.targetNodeId, port: toPortCellId(edge.targetNodeId, edge.targetPortId) },
    data: edge,
    router: { name: "manhattan" },
    connector: { name: "smooth", args: { radius: 12 } },
    attrs: {
      line: {
        stroke: "#8c9bab",
        strokeWidth: 1.5,
        targetMarker: { name: "block", size: 6 },
      },
    },
  };
}

/** 通用节点 React 卡片组件。 */
function WorkflowNodeView(props: { readonly node: Node; readonly graph: Graph }) {
  const data = props.node.getData<EditorGraphNode | undefined>();
  if (data === undefined) {
    return <div className="hnflow-node-card">（数据缺失）</div>;
  }
  if (data.type === "subworkflow") {
    return <SubworkflowNode node={props.node} />;
  }
  const hasSubworkflow = data.subworkflow !== undefined;
  return (
    <div className={`hnflow-node-card${hasSubworkflow ? " hnflow-node-card-subworkflow" : ""}`}>
      <div className="hnflow-node-title" title={data.name}>
        {data.name}
      </div>
      <span className="hnflow-node-badge">{data.type}</span>
      {hasSubworkflow && <span className="hnflow-node-tip">子流程 · 双击进入</span>}
    </div>
  );
}

/** 注册通用节点形状（模块加载时执行一次；同名注册幂等覆盖）。 */
register({
  shape: NODE_SHAPE,
  component: WorkflowNodeView,
  width: NODE_WIDTH,
  height: NODE_MIN_HEIGHT,
  attrs: { body: { fill: "transparent", stroke: "transparent" } },
});
