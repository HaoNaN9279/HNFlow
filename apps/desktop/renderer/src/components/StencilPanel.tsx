// StencilPanel：节点物料面板（T6）。
// - 启动时经 useNodeTypeMetadata 拉取 16 个内置节点元数据，按类别分组展示（控制/数据/IO/AI）；
// - 拖拽：X6 Dnd 插件（@antv/x6-plugin-dnd）——mousedown 时建临时节点并 dnd.start，
//   落点在 validateNode 回调里换算成画布坐标后走 editorActions.addNode；插件返回 false 不入图，
//   EditorState 保持唯一数据源（X6 侧由 useWorkflowGraph 的 reconcile 增量同步渲染）；
// - 点击：在画布可视区中心添加节点（最小可用兜底，拖拽不可用时也可用）；
// - v0.4.1：只读模式（模板引用子图）禁止添加节点——禁用拖拽/点击入口 + 灰显 + 提示文案。

import { type CSSProperties, useMemo, useRef } from "react";
import { Graph } from "@antv/x6";
import { Dnd } from "@antv/x6-plugin-dnd";
import { Empty, Spin, Typography } from "antd";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { NodeTypeMetadata } from "../../../src/shared/ipc.js";
import { NODE_MIN_HEIGHT, NODE_WIDTH, toX6Node } from "../editor/graph-elements.js";
import type { GraphPosition } from "../editor/ports.js";
import { editorActions, useEditor } from "../editor/state.js";
import { useWorkflowGraphContext } from "../editor/useWorkflowGraph.js";
import { useNodeUi } from "../editor/ui-context.js";
import { buildMcpToolNode, useGroupTools, type GroupToolItem } from "../hooks/useGroupTools.js";
import { createDefaultNode, useNodeTypeMetadata } from "../hooks/useNodeCreation.js";

/** 物料分组常量映射：type 白名单 → 分组标题。 */
const NODE_GROUPS: readonly { readonly key: string; readonly label: string; readonly types: readonly string[] }[] = [
  {
    key: "control",
    label: "控制",
    types: ["start", "end", "ifElse", "tryCatch", "finally", "loop", "parallel", "subworkflow"],
  },
  { key: "data", label: "数据", types: ["setVariable", "log"] },
  { key: "io", label: "IO", types: ["command", "http", "file", "humanTask"] },
  { key: "ai", label: "AI", types: ["llm", "ai"] },
];

/** 未绑定标签样式：灰显声明工具，与内置节点 type 徽标区分（不占 global.css 分区）。 */
const unboundBadgeStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1,
  padding: "2px 5px",
  borderRadius: 4,
  border: "1px solid #d9d9d9",
  background: "#fafafa",
  color: "#999",
  whiteSpace: "nowrap",
};

/** 按分组索引元数据；仅保留有节点的分组。 */
function groupMetadata(list: readonly NodeTypeMetadata[]): readonly {
  readonly key: string;
  readonly label: string;
  readonly items: readonly NodeTypeMetadata[];
}[] {
  return NODE_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    items: list.filter((meta) => group.types.includes(meta.type)),
  })).filter((group) => group.items.length > 0);
}

export default function StencilPanel() {
  const { dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const { readOnly } = useNodeUi();
  const { metadata, failed } = useNodeTypeMetadata();
  const { groups: groupTools, failed: groupFailed } = useGroupTools();
  const panelRef = useRef<HTMLDivElement>(null);
  const dndRef = useRef<Dnd | null>(null);

  const groups = useMemo(() => (metadata === undefined ? [] : groupMetadata(metadata)), [metadata]);

  /** 懒初始化 Dnd：图实例就绪后才可创建；validateNode 拦截落点转 addNode（插件不入图）。 */
  function getDnd(graph: Graph): Dnd {
    if (dndRef.current === null) {
      dndRef.current = new Dnd({
        target: graph,
        scaled: false,
        ...(panelRef.current === null ? {} : { dndContainer: panelRef.current }),
        validateNode: (droppingNode) => {
          const data = droppingNode.getData<EditorGraphNode | undefined>();
          if (data === undefined) {
            return false;
          }
          const pos = droppingNode.getPosition();
          dispatch(editorActions.addNode({ ...data, position: { x: pos.x, y: pos.y } }));
          return false;
        },
      });
    }
    return dndRef.current;
  }

  /** 拖拽起点：建临时节点交给 Dnd 插件渲染幽灵并计算落点。 */
  function handleMouseDown(meta: NodeTypeMetadata, evt: React.MouseEvent): void {
    const graph = graphRef.current;
    if (graph === null) {
      return; // 图未就绪：本次不响应拖拽（点击添加仍可用）
    }
    evt.preventDefault();
    const editorNode = createDefaultNode(meta.type, meta, { x: 0, y: 0 });
    const node = graph.createNode(toX6Node(editorNode));
    getDnd(graph).start(node, evt.nativeEvent);
  }

  /** 画布可视区中心（本地坐标，扣除节点尺寸保证完整落在画布内）。 */
  function canvasCenter(graph: Graph): GraphPosition {
    const area = graph.getGraphArea();
    return {
      x: area.x + (area.width - NODE_WIDTH) / 2,
      y: area.y + (area.height - NODE_MIN_HEIGHT) / 2,
    };
  }

  /** 点击添加：在画布可视区中心创建节点（最小可用兜底）。 */
  function handleClick(meta: NodeTypeMetadata): void {
    const graph = graphRef.current;
    const position = graph === null ? { x: 40, y: 40 } : canvasCenter(graph);
    dispatch(editorActions.addNode(createDefaultNode(meta.type, meta, position)));
  }

  /** 功能组 MCP 物料拖拽起点：建 mcpTool 临时节点交给 Dnd（复用内置节点拖拽机制）。 */
  function handleItemMouseDown(item: GroupToolItem, evt: React.MouseEvent): void {
    if (item.kind !== "mcp" || item.mcpConfig === undefined) {
      return; // 未绑定声明工具不响应拖拽
    }
    const graph = graphRef.current;
    if (graph === null) {
      return;
    }
    evt.preventDefault();
    const editorNode = buildMcpToolNode(item, { x: 0, y: 0 });
    const node = graph.createNode(toX6Node(editorNode));
    getDnd(graph).start(node, evt.nativeEvent);
  }

  /** 功能组 MCP 物料点击添加：画布可视区中心创建 mcpTool 节点（同内置节点兜底）。 */
  function handleItemClick(item: GroupToolItem): void {
    if (item.kind !== "mcp" || item.mcpConfig === undefined) {
      return;
    }
    const graph = graphRef.current;
    const position = graph === null ? { x: 40, y: 40 } : canvasCenter(graph);
    dispatch(editorActions.addNode(buildMcpToolNode(item, position)));
  }

  return (
    <div ref={panelRef} className="stencil-panel">
      <Typography.Text strong>节点库</Typography.Text>
      {readOnly && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#999", userSelect: "none" }}>只读模式禁止添加节点</div>
      )}
      {metadata === undefined && !failed ? (
        <div style={{ padding: 24, textAlign: "center" }}>
          <Spin size="small" />
        </div>
      ) : failed ? (
        <Empty description="节点类型加载失败" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : groups.length === 0 ? (
        <Empty description="无可用节点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        groups.map((group) => (
          <div key={group.key} className="stencil-group">
            <div className="stencil-group-title">{group.label}</div>
            {group.items.map((meta) => (
              <div
                key={meta.type}
                className="stencil-item"
                style={readOnly ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                onMouseDown={readOnly ? undefined : (evt) => handleMouseDown(meta, evt)}
                onClick={readOnly ? undefined : () => handleClick(meta)}
                title={readOnly ? "只读模式禁止添加节点" : `拖拽到画布或点击添加（${meta.name}）`}
              >
                <span className="stencil-item-name">{meta.name}</span>
                <span className="hnflow-node-badge">{meta.type}</span>
              </div>
            ))}
          </div>
        ))
      )}
      {groupTools !== undefined && !groupFailed && (
        <>
          <Typography.Text strong>功能组</Typography.Text>
          {groupTools.length === 0 ? (
            <Empty description="无功能组工具" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            groupTools.map((group) => (
              <div key={group.key} className="stencil-group">
                <div className="stencil-group-title">{group.label}</div>
                {group.items.map((item) => (
                  <div
                    key={`${item.kind}:${item.name}`}
                    className="stencil-item"
                    style={readOnly || !item.bound ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                    onMouseDown={readOnly || !item.bound ? undefined : (evt) => handleItemMouseDown(item, evt)}
                    onClick={readOnly || !item.bound ? undefined : () => handleItemClick(item)}
                    title={
                      readOnly
                        ? "只读模式禁止添加节点"
                        : item.bound
                          ? `拖拽到画布或点击添加（MCP Server: ${item.name}，工具名在参数面板填写）`
                          : `未绑定（${item.description}）`
                    }
                  >
                    <span className="stencil-item-name">{item.name}</span>
                    {item.bound ? (
                      <span className="hnflow-node-badge">mcp</span>
                    ) : (
                      <span style={unboundBadgeStyle}>未绑定</span>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
