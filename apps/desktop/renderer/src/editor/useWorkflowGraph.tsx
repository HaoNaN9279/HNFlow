// useWorkflowGraph：EditorState.graph ↔ X6 Graph 渲染桥。
// - 挂载时创建 X6 Graph 并注册插件 5 件套（Snapline/Clipboard/Keyboard/History/Selection），兼容 StrictMode 双挂载；
// - EditorGraph → X6 增量同步；X6 → EditorState 经 callbacks 回传；undo/redo 后 exportGraphState 回写 EditorState。

import { createContext, useContext, useEffect, useMemo, useRef, type Dispatch, type ReactNode, type RefObject } from "react";
import { Graph, type Node } from "@antv/x6";
import { Clipboard } from "@antv/x6-plugin-clipboard";
import { History } from "@antv/x6-plugin-history";
import { Keyboard } from "@antv/x6-plugin-keyboard";
import { Selection } from "@antv/x6-plugin-selection";
import { Snapline } from "@antv/x6-plugin-snapline";
import type { EditorGraph, EditorGraphNode } from "@core/editing/editor-graph";
import type { Edge } from "@core/model/types";
import { editorActions, type EditorAction } from "./state.js";
import { NODE_WIDTH, buildPorts, nodeHeight, toX6Edge, toX6Node } from "./graph-elements.js";
import { toPortCellId, type GraphPosition } from "./ports.js";

/** 可写图实例 ref：RefObject.current 只读，自声明可变窄口（T6/T7 读取用）。 */
export interface MutableGraphRef {
  current: Graph | null;
}

/** X6 → EditorState 基础回传（选中/取消选中/拖拽位移）。 */
export interface WorkflowGraphCallbacks {
  readonly onNodeSelected?: (nodeId: string) => void;
  readonly onSelectionCleared?: () => void;
  readonly onNodeMoved?: (nodeId: string, position: GraphPosition) => void;
}

/** useWorkflowGraph 初始化选项。 */
export interface WorkflowGraphOptions {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly graphRef: MutableGraphRef;
}

// ── 撤销/重做（History 插件 + undo/redo 后状态回写）───────────────────────────────────
let historyPlugin: History | null = null;
let graphInstance: Graph | null = null;
let undoRedoSync: ((instance: Graph) => void) | null = null;
const initializedGraphs = new WeakSet<Graph>();

/** 撤销一次 X6 模型变更；无可撤销时返回 false。 */
export function graphUndo(): boolean {
  if (historyPlugin === null || !historyPlugin.canUndo()) {
    return false;
  }
  historyPlugin.undo();
  graphInstance !== null && undoRedoSync?.(graphInstance);
  return true;
}

/** 重做一次 X6 模型变更；无可重做时返回 false。 */
export function graphRedo(): boolean {
  if (historyPlugin === null || !historyPlugin.canRedo()) {
    return false;
  }
  historyPlugin.redo();
  graphInstance !== null && undoRedoSync?.(graphInstance);
  return true;
}

/** 从 X6 全量导出当前图（undo/redo 后回写 EditorState；data 为 T5 reconcile 存入的节点/边引用）。 */
export function exportGraphState(instance: Graph): EditorGraph {
  const nodes = instance.getNodes().map((n) => ({ ...(n.getData() as EditorGraphNode), position: n.getPosition() }));
  const edges = instance.getEdges().map((e) => e.getData() as Edge);
  const entry = nodes.find((n) => n.type === "start");
  return { nodes, edges, ...(entry === undefined ? {} : { entryNodeId: entry.id }) };
}
// ── 共享图实例上下文（T6/T7/T9 经 useWorkflowGraphContext 拿图后自行挂事件）────────────────
interface WorkflowGraphContextValue {
  readonly graphRef: MutableGraphRef;
}

const WorkflowGraphContext = createContext<WorkflowGraphContextValue | null>(null);

/** 提供共享 X6 图实例 ref；配合 useEditor() 使用（App.tsx 包裹整个编辑器 UI）。 */
export function WorkflowGraphProvider({ children }: { readonly children: ReactNode }) {
  const graphRef = useRef<Graph | null>(null);
  const value = useMemo(() => ({ graphRef }), []);
  return <WorkflowGraphContext.Provider value={value}>{children}</WorkflowGraphContext.Provider>;
}
/** 读取当前 X6 图实例（挂载后非 null）；T6/T7 在 effect 内取用并 graph.on(...) 监听。 */
export function useWorkflowGraphContext(): MutableGraphRef {
  const ctx = useContext(WorkflowGraphContext);
  if (ctx === null) {
    throw new Error("useWorkflowGraphContext 必须在 <WorkflowGraphProvider> 内使用");
  }
  return ctx.graphRef;
}
// ── 增量同步（EditorGraph → X6）──────────────────────────────────────────────────────
function syncNodeCell(cell: Node, node: EditorGraphNode): void {
  const position = cell.getPosition();
  if (position.x !== node.position.x || position.y !== node.position.y) {
    cell.setPosition(node.position, { history: false });
  }
  const size = cell.getSize();
  const targetHeight = nodeHeight(node);
  if (size.width !== NODE_WIDTH || size.height !== targetHeight) {
    cell.setSize(NODE_WIDTH, targetHeight, { history: false });
  }
  if (cell.getData() !== node) {
    cell.setData(node, { history: false }); // 回流不入 undo 栈：防 setGraph 回写后 data 记录无限堆叠
  }
  const targetPortIds = new Set(node.inputs.concat(node.outputs).map((port) => toPortCellId(node.id, port.id)));
  const currentPortIds = new Set(cell.getPorts().map((port) => port.id));
  if (targetPortIds.size !== currentPortIds.size || [...targetPortIds].some((id) => !currentPortIds.has(id))) {
    cell.setProp("ports", buildPorts(node), { history: false });
  }
}
function reconcile(instance: Graph, target: EditorGraph): void {
  // 节点/边：移除多余 → 新增/更新（回流更新带 history:false，见 syncNodeCell）
  const xNodes = new Map(instance.getNodes().map((n) => [n.id, n]));
  const targetNodeIds = new Set(target.nodes.map((n) => n.id));
  for (const cell of xNodes.values()) {
    if (!targetNodeIds.has(cell.id)) {
      instance.removeCell(cell.id);
    }
  }
  for (const node of target.nodes) {
    const existing = xNodes.get(node.id);
    if (existing === undefined) {
      instance.addNode(toX6Node(node));
    } else {
      syncNodeCell(existing, node);
    }
  }
  const xEdges = new Map(instance.getEdges().map((e) => [e.id, e]));
  const targetEdgeIds = new Set(target.edges.map((e) => e.id));
  for (const cell of xEdges.values()) {
    if (!targetEdgeIds.has(cell.id)) {
      instance.removeCell(cell.id);
    }
  }
  for (const edge of target.edges) {
    const existing = xEdges.get(edge.id);
    if (existing === undefined) {
      instance.addEdge(toX6Edge(edge));
    } else if (existing.getData() !== edge) {
      existing.setSource({ cell: edge.sourceNodeId, port: toPortCellId(edge.sourceNodeId, edge.sourcePortId) }, { history: false });
      existing.setTarget({ cell: edge.targetNodeId, port: toPortCellId(edge.targetNodeId, edge.targetPortId) }, { history: false });
      existing.setData(edge, { history: false });
    }
  }
}
// ── Hook：图创建 + 插件注册 + 事件接线 + 渲染同步 ─────────────────────────────────────
/** 桥接 EditorGraph 与 X6 Graph；dispatch 供 undo/redo 后回写 setGraph。 */
export function useWorkflowGraph(
  graph: EditorGraph,
  callbacks: WorkflowGraphCallbacks,
  options: WorkflowGraphOptions,
  dispatch: Dispatch<EditorAction>,
): { readonly graphRef: MutableGraphRef } {
  const { containerRef, graphRef } = options;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const currentGraphRef = useRef(graph);
  currentGraphRef.current = graph;
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const instance = new Graph({
      container,
      autoResize: true,
      background: { color: "#fafafa" },
      grid: { size: 20, visible: true, type: "mesh", args: { color: "#e5e5e5", thickness: 1 } },
      panning: { enabled: true, eventTypes: ["rightMouseDown", "leftMouseDown"] },
      mousewheel: { enabled: true, minScale: 0.2, maxScale: 2.5, zoomAtMousePosition: true },
      connecting: {
        snap: true,
        allowBlank: false,
        allowLoop: false,
        allowNode: false,
        allowEdge: false,
        allowPort: true,
        allowMulti: false,
        highlight: true,
        router: "manhattan",
        connector: "smooth",
        // T7 接线点：拖线新建的边沿用 toX6Edge 同款样式（T5 已建边样式不变）
        createEdge(this: Graph) {
          return this.createEdge({
            router: { name: "manhattan" },
            connector: { name: "smooth", args: { radius: 12 } },
            attrs: {
              line: {
                stroke: "#8c9bab",
                strokeWidth: 1.5,
                targetMarker: { name: "block", size: 6 },
              },
            },
          });
        },
      },
    });
    graphRef.current = instance;
    graphInstance = instance;
    instance.use(new Snapline({ enabled: true, sharp: true }));
    instance.use(new Clipboard({ enabled: true }));
    instance.use(new Keyboard({ enabled: true, global: true }));
    // mod=mac cmd / 其他平台 ctrl；输入框中由插件 isInputEvent 自动放行
    instance.bindKey("mod+z", () => graphUndo(), "keydown");
    instance.bindKey(["mod+shift+z", "ctrl+y"], () => graphRedo(), "keydown");
    const history = new History({
      enabled: true,
      // reconcile 回流（setData/setPosition 等）标记 history:false，此处过滤不入 undo 栈
      beforeAddCommand: (_event, args) =>
        (args as { readonly options?: { readonly history?: unknown } }).options?.history !== false,
    });
    instance.use(history);
    historyPlugin = history;
    instance.use(new Selection({ enabled: true, multiple: true, rubberband: true, modifiers: "shift", showNodeSelectionBox: false }));
    instance.on("node:click", ({ node }) => {
      callbacksRef.current.onNodeSelected?.(node.id);
    });
    instance.on("blank:click", () => {
      callbacksRef.current.onSelectionCleared?.();
    });
    instance.on("node:moved", ({ node }) => {
      const position = node.getPosition();
      callbacksRef.current.onNodeMoved?.(node.id, { x: position.x, y: position.y });
    });
    const syncUndoRedo = (target: Graph): void => {
      // 保留原 graph meta 与层级栈：replaceGraph 只换 graph，不跳子层
      dispatch(editorActions.replaceGraph({ ...currentGraphRef.current, ...exportGraphState(target) }));
    };
    undoRedoSync = syncUndoRedo;
    return () => {
      historyPlugin = null;
      graphInstance = null;
      undoRedoSync = null;
      instance.dispose();
      if (graphRef.current === instance) {
        graphRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在挂载时创建一次
  }, []);
  // graph 变化：增量同步（含首次渲染；首次 clean 保证加载不可 undo）
  useEffect(() => {
    const instance = graphRef.current;
    if (instance === null) {
      return;
    }
    reconcile(instance, graph);
    if (!initializedGraphs.has(instance)) {
      initializedGraphs.add(instance);
      instance.cleanHistory();
    }
  }, [graph]);

  return { graphRef };
}
