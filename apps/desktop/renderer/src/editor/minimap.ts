// minimap：MiniMap 插件注册（v0.4.1 从 useWorkflowGraph 独立拆出，控制主文件 ≤250 行）。
// - SimpleNodeView：MiniMap 内节点纯矩形渲染，避免全量 React 渲染卡顿（官方示例模式）；
// - registerMiniMap：封装 MiniMap 注册（width/height/graphOptions/createCellView 原逻辑）。

import { Graph, NodeView } from "@antv/x6";
import { MiniMap } from "@antv/x6-plugin-minimap";

/** MiniMap 简化节点渲染：纯矩形，避免全量 React 渲染（官方示例模式）。 */
export class SimpleNodeView extends NodeView {
  protected renderMarkup() {
    return this.renderJSONMarkup({ tagName: "rect", selector: "body" });
  }
  update() {
    super.update({ body: { refWidth: "100%", refHeight: "100%", fill: "#8f8f8f" } });
  }
}

/** 注册 MiniMap 插件（useWorkflowGraph 在容器非 null 时调用；React 节点走 SimpleNodeView 纯矩形渲染）。 */
export function registerMiniMap(instance: Graph, container: HTMLElement): void {
  instance.use(
    new MiniMap({
      container,
      width: 200,
      height: 150,
      graphOptions: { createCellView: (cell) => (cell.isNode() ? SimpleNodeView : undefined) },
    }),
  );
}
