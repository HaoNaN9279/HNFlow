// useReadOnlyMode：模板引用子图只读模式（X6 交互禁用 + 删除入口兜底）。
//
// 探索结论（@antv/x6 2.19.2，读 node_modules 类型/源码）：
// - CellView.can(feature) 每次调用都实时读 graph.options.interacting（lib/view/cell.js:218），
//   支持 boolean（false 全禁）→ 首选方案：运行时赋值 graph.options.interacting = false。
//   覆盖 nodeMovable / magnetConnectable / edgeMovable / arrowheadMovable / vertexMovable /
//   vertexAddable / vertexDeletable / useEdgeTools / toolsAddable，即节点移动、端口拖线、
//   边拖动、边箭头/顶点编辑、edge-tool 删除全部关闭（恢复时还原进入前值）。
//   X6 Cell 模型无 interacting 属性（lib/model/cell.d.ts 无匹配），per-node setProp 方案不存在。
// - 兜底 1（Delete/Backspace 删边）：useEdgeConnect 绑定该键且不读 readOnly → 只读时用 Mousetrap
//   后绑覆盖为 noop（Mousetrap _bindSingle 移除同键旧回调）；退出只读重新 bind 等价删除实现
//   （原 handler 引用已不可还原，故提供同行为实现：遍历选中边 removeEdge）。
// - 兜底 1b（Ctrl/Cmd+Z 撤销重做）：useWorkflowGraph 绑 mod+z / mod+shift+z / ctrl+y → 只读时同法
//   覆盖为 noop；退出只读 bind 等价实现（graphUndo/graphRedo），行为与原来一致。
// - 兜底 2（右键删边）：useEdgeConnect 的 edge:contextmenu 直接 dispatch removeEdge → 只读时注册
//   晚于它的 handler 把边 addEdge 回 state（X6 边 data 即 @core Edge；React 18 自动批处理，
//   remove+add 两次 dispatch 净零，state 不变则 reconcile 无 diff，X6 边保留）。
//   注册顺序由 WorkflowCanvas 中 hook 调用顺序保证：useEdgeConnect() 在 useReadOnlyMode() 之前。

import { useEffect, useRef } from "react";
import type { CellView, Edge as X6Edge } from "@antv/x6";
import type { Edge as CoreEdge } from "@core/model/types";
import { editorActions, useEditor } from "../editor/state.js";
import { graphRedo, graphUndo } from "../editor/useWorkflowGraph.js";
import { useNodeUi } from "../editor/ui-context.js";
import { useWorkflowGraphContext } from "../editor/useWorkflowGraph.js";

/** 右键删边回滚 handler 类型（effect 间共享引用，供 graph.off 精确移除）。 */
type RollbackHandler = (args: { readonly edge: X6Edge }) => void;

/** 只读模式：readOnly 变化时启用/禁用 X6 画布全部编辑交互。 */
export function useReadOnlyMode(): void {
  const { readOnly } = useNodeUi();
  const { dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  /** 进入只读前的 interacting 配置（退出时还原）。 */
  const previousInteractingRef = useRef<CellView.Interacting | undefined>(undefined);
  /** 当前 rollback handler 引用（effect 重跑时精确 off）。 */
  const rollbackRef = useRef<RollbackHandler | null>(null);

  useEffect(() => {
    const graph = graphRef.current;
    if (graph === null) {
      return;
    }
    // 首次执行记录初始 interacting（后续进入/退出只读均基于该值还原）。
    if (previousInteractingRef.current === undefined) {
      previousInteractingRef.current = graph.options.interacting;
    }
    if (readOnly) {
      // 主防御：X6 原生交互开关（CellView.can 实时读取，见文件头探索结论）。
      graph.options.interacting = false;
      // 兜底 1：Delete/Backspace 删边覆盖为 noop（后绑替换 useEdgeConnect 的删除）。
      graph.bindKey(["delete", "backspace"], () => undefined);
      // 兜底 1b：撤销/重做快捷键覆盖为 noop（后绑替换 useWorkflowGraph 的绑定）。
      graph.bindKey("mod+z", () => undefined, "keydown");
      graph.bindKey(["mod+shift+z", "ctrl+y"], () => undefined, "keydown");
      // 兜底 2：右键删边回滚——注册晚于 useEdgeConnect，其 removeEdge 之后本 handler addEdge 抵消。
      const rollback: RollbackHandler = ({ edge }) => {
        const core = edge.getData<CoreEdge | undefined>();
        if (core !== undefined) {
          dispatchRef.current(editorActions.addEdge(core));
        }
      };
      rollbackRef.current = rollback;
      graph.on("edge:contextmenu", rollback);
    } else {
      // 退出只读：还原 interacting，恢复 Delete/Backspace 删边（等价 useEdgeConnect 实现）。
      graph.options.interacting = previousInteractingRef.current ?? graph.options.interacting;
      graph.bindKey(["delete", "backspace"], () => {
        for (const cell of graph.getSelectedCells()) {
          if (cell.isEdge()) {
            dispatchRef.current(editorActions.removeEdge(cell.id));
          }
        }
      });
      // 恢复撤销/重做快捷键（等价 useWorkflowGraph 绑定：graphUndo/graphRedo）。
      graph.bindKey("mod+z", () => graphUndo(), "keydown");
      graph.bindKey(["mod+shift+z", "ctrl+y"], () => graphRedo(), "keydown");
      if (rollbackRef.current !== null) {
        graph.off("edge:contextmenu", rollbackRef.current);
        rollbackRef.current = null;
      }
    }
    return () => {
      // 切换/卸载时还原：interacting 回进入前值；精确移除 rollback（不动 useEdgeConnect 的 handler）。
      if (graphRef.current !== null) {
        graphRef.current.options.interacting = previousInteractingRef.current ?? graphRef.current.options.interacting;
      }
      if (rollbackRef.current !== null) {
        graph.off("edge:contextmenu", rollbackRef.current);
        rollbackRef.current = null;
      }
    };
  }, [readOnly, graphRef]);
}
