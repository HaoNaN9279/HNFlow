// undo-redo：撤销/重做（History 插件 + undo/redo 后状态回写）。
// - useWorkflowGraph 挂载时 registerUndoRedo 注入回写闭包，卸载时 unregisterUndoRedo 清除；
// - graphUndo/graphRedo 经 WorkflowCanvas re-export 供工具栏（T10）消费；exportGraphState 供 undo/redo 后全量导出。

import { Graph } from "@antv/x6";
import { History } from "@antv/x6-plugin-history";
import type { EditorGraph, EditorGraphNode } from "@core/editing/editor-graph";
import type { Edge } from "@core/model/types";

let historyPlugin: History | null = null;
let graphInstance: Graph | null = null;
let undoRedoSync: ((instance: Graph) => void) | null = null;

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

/** 绑定模块级 undo/redo 状态（useWorkflowGraph 挂载时注入 History 实例与回写闭包）。 */
export function registerUndoRedo(history: History, instance: Graph, sync: (target: Graph) => void): void {
  historyPlugin = history;
  graphInstance = instance;
  undoRedoSync = sync;
}

/** 清除模块级 undo/redo 状态（useWorkflowGraph 卸载时调用）。 */
export function unregisterUndoRedo(): void {
  historyPlugin = null;
  graphInstance = null;
  undoRedoSync = null;
}
