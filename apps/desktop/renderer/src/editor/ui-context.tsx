// NodeUiContext：编辑器共享 UI 上下文（v0.4.1 新增）。
// - menuTarget：右键菜单目标节点（subworkflow 节点，X6 data 中的 EditorGraphNode）；
// - readOnly：全局只读模式（T8 消费：模板引用子图内部编辑默认只读）；
// - 升级/历史入口：openUpgrade/openHistory 由右键菜单调用，内部持有 upgradeTarget/historyTarget，
//   并在 Provider 内渲染 <UpgradeDialog/>/<HistoryDialog/>（全局可用，无需各面板自行挂载）。
// 消费约定：SubworkflowNode 右键菜单经 useNodeUi() 调 openUpgrade/openHistory；
// ConfigPanel/StencilPanel/Canvas 读 readOnly/menuTarget 做 UI 差异化。

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { HistoryDialog } from "./HistoryDialog.js";
import { UpgradeDialog } from "./UpgradeDialog.js";

/** 共享 UI 上下文契约（Provider 外消费抛错，同 useEditor 风格）。 */
export interface NodeUiContextValue {
  /** 右键菜单目标节点（subworkflow 节点，X6 data 中的 EditorGraphNode）。 */
  readonly menuTarget: EditorGraphNode | undefined;
  readonly setMenuTarget: (node: EditorGraphNode | undefined) => void;
  /** 全局只读模式（T8 消费：模板引用子图内部编辑默认只读）。 */
  readonly readOnly: boolean;
  readonly setReadOnly: (value: boolean) => void;
  /** 打开升级向导（右键菜单「升级版本」调用）。 */
  readonly openUpgrade: (node: EditorGraphNode) => void;
  /** 打开历史查看（右键菜单「查看历史」调用）。 */
  readonly openHistory: (node: EditorGraphNode) => void;
}

const NodeUiContext = createContext<NodeUiContextValue | null>(null);

/** 全局共享 UI 状态 Provider：App.tsx 在 WorkflowGraphProvider 内包裹，升级/历史 Modal 随 Provider 挂载。 */
export function NodeUiProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [menuTarget, setMenuTarget] = useState<EditorGraphNode | undefined>(undefined);
  const [readOnly, setReadOnly] = useState(false);
  const [upgradeTarget, setUpgradeTarget] = useState<EditorGraphNode | undefined>(undefined);
  const [historyTarget, setHistoryTarget] = useState<EditorGraphNode | undefined>(undefined);

  const openUpgrade = useCallback(
    (node: EditorGraphNode) => {
      setMenuTarget(undefined); // 打开向导同时关闭右键菜单
      setUpgradeTarget(node);
    },
    [],
  );
  const openHistory = useCallback(
    (node: EditorGraphNode) => {
      setMenuTarget(undefined);
      setHistoryTarget(node);
    },
    [],
  );

  const value = useMemo<NodeUiContextValue>(
    () => ({ menuTarget, setMenuTarget, readOnly, setReadOnly, openUpgrade, openHistory }),
    [menuTarget, readOnly, openUpgrade, openHistory],
  );

  return (
    <NodeUiContext.Provider value={value}>
      {children}
      <UpgradeDialog target={upgradeTarget} onClose={() => setUpgradeTarget(undefined)} />
      <HistoryDialog target={historyTarget} onClose={() => setHistoryTarget(undefined)} />
    </NodeUiContext.Provider>
  );
}

/** 消费共享 UI 上下文：Provider 外使用抛 Error（同 useEditor 风格）。 */
export function useNodeUi(): NodeUiContextValue {
  const ctx = useContext(NodeUiContext);
  if (ctx === null) {
    throw new Error("useNodeUi 必须在 <NodeUiProvider> 内使用");
  }
  return ctx;
}
