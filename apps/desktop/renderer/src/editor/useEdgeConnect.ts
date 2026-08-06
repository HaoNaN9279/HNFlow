// T7 连线交互接入：把 edge-connect 纯校验挂到 X6 画布，并回写 EditorState。
//
// - connecting.validateConnection：拖线时实时校验（拒绝时中文 message 提示，节流防刷屏）；
// - edge:connected：连线成功后构造 @core Edge → addEdge（重连则先 removeEdge 再 addEdge）；
// - edge:removed / 右键删除 / Delete（Backspace）删除：回写 removeEdge；
// - X6 为权威渲染、EditorState 为权威数据：X6 操作事件单向回写 state，再经
//   useWorkflowGraph.reconcile 把 state 差异反灌回 X6，形成双向同步闭环。

import { useEffect, useRef } from "react";
import { message } from "antd";
import type { Edge as X6Edge } from "@antv/x6";
import type { Edge as CoreEdge } from "@core/model/types";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { useEditor, editorActions } from "./state.js";
import { useWorkflowGraphContext } from "./useWorkflowGraph.js";
import { parsePortCellId } from "./ports.js";
import { validateConnection, type ConnectionEndpoint } from "./edge-connect.js";

/** 同一条拒绝消息的最小展示间隔（拖线悬停会高频触发 validateConnection，防刷屏）。 */
const MESSAGE_THROTTLE_MS = 1200;

/** 把 X6 port cell id 解析为 @core 端口信息（从当前 EditorState 图查 Port 类型/方向）。 */
function resolveEndpoint(
  portCellId: string | null | undefined,
  graphNodes: readonly EditorGraphNode[],
): ConnectionEndpoint | undefined {
  if (portCellId === undefined || portCellId === null) {
    return undefined;
  }
  const parsed = parsePortCellId(portCellId);
  if (parsed === undefined) {
    return undefined;
  }
  const node = graphNodes.find((item) => item.id === parsed.nodeId);
  if (node === undefined) {
    return undefined;
  }
  const port = node.inputs.concat(node.outputs).find((item) => item.id === parsed.portId);
  if (port === undefined) {
    return undefined;
  }
  return { nodeId: parsed.nodeId, portId: parsed.portId, portType: port.type, direction: port.direction };
}

/** 把 X6 边还原为 @core Edge；任一端点缺失/端口 id 非法返回 undefined。 */
function toCoreEdge(edge: X6Edge): CoreEdge | undefined {
  const sourceNodeId = edge.getSourceCellId();
  const targetNodeId = edge.getTargetCellId();
  const sourcePortCellId = edge.getSourcePortId();
  const targetPortCellId = edge.getTargetPortId();
  if (sourcePortCellId === undefined || targetPortCellId === undefined) {
    return undefined;
  }
  const source = parsePortCellId(sourcePortCellId);
  const target = parsePortCellId(targetPortCellId);
  if (source === undefined || target === undefined) {
    return undefined;
  }
  return {
    id: edge.id,
    sourceNodeId,
    sourcePortId: source.portId,
    targetNodeId,
    targetPortId: target.portId,
  };
}

/** 挂载 X6 连线事件（WorkflowCanvas 内调用，须在 useWorkflowGraph 之后，保证图实例已建）。 */
export function useEdgeConnect(): void {
  const { state, dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const nodesRef = useRef(state.graph.nodes);
  nodesRef.current = state.graph.nodes;
  const edgesRef = useRef(state.graph.edges);
  edgesRef.current = state.graph.edges;

  useEffect(() => {
    const graph = graphRef.current;
    if (graph === null) {
      return;
    }
    const previousValidate = graph.options.connecting.validateConnection;
    const lastHint = { reason: "", at: 0 };

    const hint = (reason: string): void => {
      const now = Date.now();
      if (reason === lastHint.reason && now - lastHint.at < MESSAGE_THROTTLE_MS) {
        return;
      }
      lastHint.reason = reason;
      lastHint.at = now;
      void message.warning(reason);
    };

    graph.options.connecting.validateConnection = (args) => {
      const source = resolveEndpoint(args.sourcePort, nodesRef.current);
      const target = resolveEndpoint(args.targetPort, nodesRef.current);
      // 源/目标单端已知即可先校验方向（拖线起点就被拒绝，不等悬停到目标）
      if (source !== undefined && source.direction !== undefined && source.direction !== "out") {
        hint("连线方向错误：只能从输出端口开始连线");
        return false;
      }
      if (target !== undefined && target.direction !== undefined && target.direction !== "in") {
        hint("连线方向错误：只能连接到输入端口");
        return false;
      }
      if (source === undefined || target === undefined) {
        return true;
      }
      // 重连既有边时排除自身，避免"输入端口已连接/成环"误判
      const pendingId = args.edge?.id;
      const existing = pendingId === undefined ? edgesRef.current : edgesRef.current.filter((edge) => edge.id !== pendingId);
      const result = validateConnection(source, target, existing);
      if (!result.ok) {
        hint(result.reason ?? "连线不被允许");
        return false;
      }
      return true;
    };

    const handleConnected = ({ edge }: { readonly edge: X6Edge }): void => {
      const coreEdge = toCoreEdge(edge);
      if (coreEdge === undefined) {
        return;
      }
      // 重连：先移除旧边再写入新边（reducer 无 updateEdge，addEdge 对同 id 幂等忽略）
      dispatchRef.current(editorActions.removeEdge(coreEdge.id));
      dispatchRef.current(editorActions.addEdge(coreEdge));
    };
    const handleRemoved = ({ edge }: { readonly edge: X6Edge }): void => {
      dispatchRef.current(editorActions.removeEdge(edge.id));
    };
    const handleContextMenu = ({ edge }: { readonly edge: X6Edge }): void => {
      dispatchRef.current(editorActions.removeEdge(edge.id));
    };
    const handleDelete = (): void => {
      for (const cell of graph.getSelectedCells()) {
        if (cell.isEdge()) {
          dispatchRef.current(editorActions.removeEdge(cell.id));
        }
      }
    };

    graph.on("edge:connected", handleConnected);
    graph.on("edge:removed", handleRemoved);
    graph.on("edge:contextmenu", handleContextMenu);
    graph.bindKey(["delete", "backspace"], handleDelete);

    return () => {
      graph.options.connecting.validateConnection = previousValidate;
      graph.off("edge:connected", handleConnected);
      graph.off("edge:removed", handleRemoved);
      graph.off("edge:contextmenu", handleContextMenu);
      graph.unbindKey(["delete", "backspace"]);
    };
  }, [graphRef]);
}
