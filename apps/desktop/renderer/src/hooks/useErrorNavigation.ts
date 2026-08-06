// useErrorNavigation：错误面板「点击直达」导航（v0.4.2 验收 5）。
//
// 给定失败节点 nodePath（「顶层工作流 > A > B」，B 为叶子节点名）+ 当前编辑器状态，
// 逐层进入子工作流 → 定位并高亮叶子节点（centerCell + graph.select + dispatch selectNode，
// 复用 CanvasToolsOverlay 搜索定位同款做法；选中高亮走既有 .x6-node-selected CSS）。
//
// 执行模型：effect 驱动逐层推进——navigateToError 记录待导航路径（pendingNav），
// 当前层图变化（state.graph）后 effect 重跑、按当前层重新解析计划并只推进一层：
// - ok + 容器待进入 → enterSubworkflow 进入第一层（内嵌子图同步 pushLevel，state.graph 更新后重跑）；
// - ok + 叶子在当前层 → 定位叶子（centerCell + select）；
// - blocked → 定位容器入口并提示「已定位到子工作流入口」（模板引用未载入等，不深入）；
// - notFound → 提示节点不在已打开的画布链上。
// 务实范围（验收 5）：只匹配当前已打开画布链；模板引用子层不深入（提示入口）。
// 无 nodePath（仅 nodeId/message）时：直接用 nodeId 在当前层尝试定位。

import { useCallback, useEffect, useState } from "react";
import { message } from "antd";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { editorActions, useEditor } from "../editor/state.js";
import { useWorkflowGraphContext } from "../editor/useWorkflowGraph.js";
import { planErrorNavigation, type ErrorTargetNode } from "../editor/error-nav.js";
import { useEditStack } from "./useEditStack.js";

/** 待导航路径（nodePath 固定不变；每次进入子层后由 effect 按新当前层重新解析计划推进）。 */
interface PendingNav {
  readonly nodePath: string;
}

export interface ErrorNavigationApi {
  /** 依据当前 runError 定位失败节点（无错误 / 无可定位信息时静默返回）。 */
  readonly navigateToError: () => void;
}

/** 按节点名或原始 id 匹配节点（与 error-nav.ts 解析口径一致）。 */
function findNodeByNameOrId(nodes: readonly EditorGraphNode[], key: string): EditorGraphNode | undefined {
  return nodes.find((node) => node.name === key || node.id === key);
}

export function useErrorNavigation(): ErrorNavigationApi {
  const { state, dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const { enterSubworkflow } = useEditStack();
  const [pendingNav, setPendingNav] = useState<PendingNav | undefined>(undefined);

  /** 定位并选中当前层 X6 节点：centerCell 居中；视图过小（scale < 0.5）时 zoomToFit 放大以便看清。 */
  const locateNode = useCallback(
    (target: ErrorTargetNode): void => {
      const graph = graphRef.current;
      if (graph === null) {
        return;
      }
      const cell = graph.getNodes().find((node) => node.id === target.id);
      if (cell === undefined) {
        message.warning(`节点「${target.name}」不在当前画布中`);
        return;
      }
      graph.centerCell(cell);
      if (graph.zoom() < 0.5) {
        graph.zoomToFit({ padding: 100, maxScale: 1.2 });
      }
      graph.select(cell);
      dispatch(editorActions.selectNode(target.id));
    },
    [graphRef, dispatch],
  );

  // 待导航路径存在时，每轮（当前层图变化后）只推进一层：进入首个容器或定位/提示。
  useEffect(() => {
    if (pendingNav === undefined) {
      return;
    }
    const plan = planErrorNavigation(state.graph, pendingNav.nodePath);
    if (plan.kind === "notFound") {
      message.warning("未找到失败节点：路径不在当前已打开的画布链上");
      setPendingNav(undefined);
      return;
    }
    if (plan.kind === "blocked") {
      locateNode(plan.blocked);
      message.info(`节点在子工作流「${plan.blocked.name}」中，已定位到子工作流入口`);
      setPendingNav(undefined);
      return;
    }
    const containerName = plan.containerNames[0];
    if (containerName !== undefined) {
      const container = findNodeByNameOrId(state.graph.nodes, containerName);
      // 防御：计划已保证该容器可进入；若状态不一致（理论不发生）按 blocked 处理，避免静默卡死。
      if (container === undefined || container.type !== "subworkflow" || container.subworkflow === undefined) {
        locateNode({ id: container?.id ?? containerName, name: containerName });
        message.info(`节点在子工作流「${containerName}」中，已定位到子工作流入口`);
        setPendingNav(undefined);
        return;
      }
      // 内嵌子图同步 pushLevel；state.graph 变化后本 effect 重跑，逐层推进至叶子层。
      void enterSubworkflow(container);
      return;
    }
    locateNode(plan.leaf);
    setPendingNav(undefined);
  }, [pendingNav, state.graph, enterSubworkflow, locateNode]);

  const navigateToError = useCallback((): void => {
    const error = state.runError;
    if (error === null) {
      return;
    }
    if (error.nodePath === undefined || error.nodePath.trim() === "") {
      // 无路径：仅剩 nodeId/message——用 nodeId 在当前层尝试定位（找不到时 locateNode 提示）。
      if (error.nodeId !== undefined) {
        locateNode({ id: error.nodeId, name: error.nodeId });
      }
      return;
    }
    setPendingNav({ nodePath: error.nodePath });
  }, [state.runError, locateNode]);

  return { navigateToError };
}
