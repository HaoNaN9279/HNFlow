// EditorState 契约：renderer 编辑器全局不可变状态容器（React Context + useReducer，零新增依赖）。
// 初始画布为 T5 示例数据（exampleEditorGraph，见 example-workflow.ts）。
//
// ── 文件分区契约（Wave 3 独立消费，各组件一律经 useEditor() 取 { state, dispatch }）────────────
// - T6  只改 StencilPanel / ConfigPanel / useNodeCreation：
//       消费 selectNode / updateNodeParams / addNode / removeNode / setGraph / selectedNodeId。
// - T7  只改 editor/edge-connect/useEdgeConnect：
//       消费 addEdge / removeEdge / graph.edges / graph.nodes[].inputs/outputs（端口校验）。
// - T9  只改 SubworkflowNode / useEditStack：
//       消费 pushLevel / popLevel / editStack / graph.nodes[].subworkflow（层级钻取）。
// - T10 工具栏撤销/重做：graphUndo/graphRedo 在 useWorkflowGraph；clipboard 类型在此声明。
//   undo/redo 后状态回流经 replaceGraph（只换 graph，保留层级栈/选中，避免子层编辑跳出）。
// - T11 新建/打开/保存：setGraph 整体替换；fromEditorGraph(state.graph) 导出。
// ──────────────────────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import type { EditorGraph, EditorGraphNode } from "@core/editing/editor-graph";
import type { Edge } from "@core/model/types";
import { exampleEditorGraph } from "./example-workflow.js";

/** 层级面包屑条目：进入某子图时记录其节点 id 与显示名（T9 useEditStack 维护）。 */
export interface EditStackItem {
  readonly id: string;
  readonly name: string;
}

/** 剪贴板载荷：T5 仅声明类型，复制/粘贴动作由 T10 撤销重做补充。 */
export interface ClipboardPayload {
  readonly nodes: readonly EditorGraphNode[];
  readonly edges: readonly Edge[];
}

/**
 * 编辑器全局不可变状态（useEditor() 对外暴露的契约）。
 * selectedNodeId 用显式联合而非可选属性：本项目开启 exactOptionalPropertyTypes，
 * reducer 内显式赋 undefined 需对应字段为 `string | undefined`；读侧语义与可选属性一致。
 */
export interface EditorState {
  /** 当前编辑层图（@core EditorGraph，子图递归内嵌于 node.subworkflow）。 */
  readonly graph: EditorGraph;
  /** 当前选中节点 id（未选中为 undefined）。 */
  readonly selectedNodeId: string | undefined;
  /** 层级面包屑栈：顶层为空数组；pushLevel/popLevel 维护。 */
  readonly editStack: readonly EditStackItem[];
  /** 剪贴板（T5 仅声明类型，T10 撤销用）。 */
  readonly clipboard?: ClipboardPayload;
}

/** 编辑器动作：受控、不可变、可判别联合（各 action 语义见注释）。 */
export type EditorAction =
  /** 整体替换图（T11 新建/打开/保存 后回灌；同时清空层级栈与选中）。 */
  | { readonly type: "setGraph"; readonly graph: EditorGraph }
  /** 仅替换当前层图（T10 撤销/重做状态回流专用；保留 editStack/levelGraphs/selectedNodeId）。 */
  | { readonly type: "replaceGraph"; readonly graph: EditorGraph }
  /** 选中/取消选中节点（nodeId 传 undefined 取消）。 */
  | { readonly type: "selectNode"; readonly nodeId: string | undefined }
  /** 进入子图编辑层：item 入面包屑栈，graph 切到子图（T9 双击子流程节点调用）。 */
  | { readonly type: "pushLevel"; readonly item: EditStackItem; readonly graph: EditorGraph }
  /** 退出当前子图层：子图编辑结果回写父节点 subworkflow 后恢复父图（T9）。 */
  | { readonly type: "popLevel" }
  /** 更新某节点 params（T6 配置面板）。 */
  | { readonly type: "updateNodeParams"; readonly nodeId: string; readonly params: Readonly<Record<string, unknown>> }
  /** 更新某节点 position（T5 补充：X6 拖拽位置回写，供 onNodeMoved 消费）。 */
  | { readonly type: "updateNodePosition"; readonly nodeId: string; readonly position: { readonly x: number; readonly y: number } }
  /** 新增节点（T6 useNodeCreation 拖放创建；重复 id 幂等忽略）。 */
  | { readonly type: "addNode"; readonly node: EditorGraphNode }
  /** 删除节点（连带删除关联边；T6/T7）。 */
  | { readonly type: "removeNode"; readonly nodeId: string }
  /** 新增边（T7 useEdgeConnect；重复 id 幂等忽略）。 */
  | { readonly type: "addEdge"; readonly edge: Edge }
  /** 删除边（T7 useEdgeConnect；边不存在则幂等忽略）。 */
  | { readonly type: "removeEdge"; readonly edgeId: string };

/** reducer 内部状态：在公共契约基础上追加层级父图快照栈（popLevel 恢复并回写子图编辑结果）。 */
interface EditorReducerState extends EditorState {
  readonly levelGraphs: readonly EditorGraph[];
}

const INITIAL_STATE: EditorReducerState = {
  graph: exampleEditorGraph,
  selectedNodeId: undefined,
  editStack: [],
  levelGraphs: [],
};

/** 不可变更新某层 graph 的指定节点（顶层专用；层级图的当前层即 state.graph）。 */
function updateNode(
  graph: EditorGraph,
  nodeId: string,
  update: (node: EditorGraphNode) => EditorGraphNode,
): EditorGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? update(n) : n)) };
}

/** 把编辑后的子图回写父节点 subworkflow（popLevel 时调用）。 */
function mergeEditedChild(parent: EditorGraph, childNodeId: string, editedChild: EditorGraph): EditorGraph {
  return updateNode(parent, childNodeId, (n) => ({ ...n, subworkflow: editedChild }));
}

function reducer(state: EditorReducerState, action: EditorAction): EditorReducerState {
  switch (action.type) {
    case "setGraph": {
      return { ...state, graph: action.graph, selectedNodeId: undefined, editStack: [], levelGraphs: [] };
    }
    case "replaceGraph": {
      return { ...state, graph: action.graph };
    }
    case "selectNode": {
      return { ...state, selectedNodeId: action.nodeId };
    }
    case "pushLevel": {
      return {
        ...state,
        graph: action.graph,
        selectedNodeId: undefined,
        editStack: [...state.editStack, action.item],
        levelGraphs: [...state.levelGraphs, state.graph],
      };
    }
    case "popLevel": {
      const parent = state.levelGraphs[state.levelGraphs.length - 1];
      const item = state.editStack[state.editStack.length - 1];
      if (parent === undefined || item === undefined) {
        return state; // 栈为空：顶层无可退出
      }
      return {
        ...state,
        graph: mergeEditedChild(parent, item.id, state.graph),
        selectedNodeId: undefined,
        editStack: state.editStack.slice(0, -1),
        levelGraphs: state.levelGraphs.slice(0, -1),
      };
    }
    case "updateNodeParams": {
      return { ...state, graph: updateNode(state.graph, action.nodeId, (n) => ({ ...n, params: action.params })) };
    }
    case "updateNodePosition": {
      return {
        ...state,
        graph: updateNode(state.graph, action.nodeId, (n) => ({ ...n, position: action.position })),
      };
    }
    case "addNode": {
      if (state.graph.nodes.some((n) => n.id === action.node.id)) {
        return state; // 幂等：重复 id 忽略
      }
      return { ...state, graph: { ...state.graph, nodes: [...state.graph.nodes, action.node] } };
    }
    case "removeNode": {
      const nodes = state.graph.nodes.filter((n) => n.id !== action.nodeId);
      if (nodes.length === state.graph.nodes.length) {
        return state; // 幂等：节点不存在
      }
      const edges = state.graph.edges.filter(
        (e) => e.sourceNodeId !== action.nodeId && e.targetNodeId !== action.nodeId,
      );
      return {
        ...state,
        graph: { ...state.graph, nodes, edges },
        selectedNodeId: state.selectedNodeId === action.nodeId ? undefined : state.selectedNodeId,
      };
    }
    case "addEdge": {
      if (state.graph.edges.some((e) => e.id === action.edge.id)) {
        return state; // 幂等：重复 id 忽略
      }
      return { ...state, graph: { ...state.graph, edges: [...state.graph.edges, action.edge] } };
    }
    case "removeEdge": {
      const edges = state.graph.edges.filter((e) => e.id !== action.edgeId);
      if (edges.length === state.graph.edges.length) {
        return state; // 幂等：边不存在
      }
      return { ...state, graph: { ...state.graph, edges } };
    }
  }
}

interface EditorContextValue {
  readonly state: EditorReducerState;
  readonly dispatch: Dispatch<EditorAction>;
}

const EditorContext = createContext<EditorContextValue | null>(null);

/** 全局状态提供者：包裹整个编辑器 UI（App.tsx 顶层）。 */
export function EditorProvider({ children }: { readonly children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

/** 消费全局状态：返回 { state, dispatch }（state 为公共契约 EditorState，无内部字段）。 */
export function useEditor(): { readonly state: EditorState; readonly dispatch: Dispatch<EditorAction> } {
  const ctx = useContext(EditorContext);
  if (ctx === null) {
    throw new Error("useEditor 必须在 <EditorProvider> 内使用");
  }
  return ctx;
}

/** 类型安全的 action 构造器：T6/T7/T9 直接调用，避免手写对象字面量。 */
export const editorActions = {
  setGraph: (graph: EditorGraph): EditorAction => ({ type: "setGraph", graph }),
  replaceGraph: (graph: EditorGraph): EditorAction => ({ type: "replaceGraph", graph }),
  selectNode: (nodeId: string | undefined): EditorAction => ({ type: "selectNode", nodeId }),
  pushLevel: (item: EditStackItem, graph: EditorGraph): EditorAction => ({ type: "pushLevel", item, graph }),
  popLevel: (): EditorAction => ({ type: "popLevel" }),
  updateNodeParams: (nodeId: string, params: Readonly<Record<string, unknown>>): EditorAction => ({
    type: "updateNodeParams",
    nodeId,
    params,
  }),
  updateNodePosition: (nodeId: string, position: { readonly x: number; readonly y: number }): EditorAction => ({
    type: "updateNodePosition",
    nodeId,
    position,
  }),
  addNode: (node: EditorGraphNode): EditorAction => ({ type: "addNode", node }),
  removeNode: (nodeId: string): EditorAction => ({ type: "removeNode", nodeId }),
  addEdge: (edge: Edge): EditorAction => ({ type: "addEdge", edge }),
  removeEdge: (edgeId: string): EditorAction => ({ type: "removeEdge", edgeId }),
} as const;
