// 子工作流节点右键菜单（v0.4.1）。
// - 事件挂载：X6 共享图实例 node:contextmenu → 仅 subworkflow 且 params.template 为 string
//   （模板引用）显示菜单：内嵌子图无升级/历史语义，忽略；右键空白/其他节点关闭；
// - 渲染：fixed 定位 AntD Menu（zIndex 高），坐标取事件 clientX/clientY；
// - 交互：「升级版本」「查看历史」→ openUpgrade/openHistory + 关闭；点击菜单外关闭；
// - 挂载：App.tsx 在 NodeUiProvider 内渲染一次（StrictMode 兼容：effect 挂/卸对称）。

import { useEffect, useState, type CSSProperties } from "react";
import { Menu } from "antd";
import type { MenuProps } from "antd";
import type { Node } from "@antv/x6";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { useWorkflowGraphContext } from "../editor/useWorkflowGraph.js";
import { useNodeUi } from "../editor/ui-context.js";

/** 右键菜单瞬时状态：出现位置 + 目标节点数据。 */
interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly nodeData: EditorGraphNode;
}

/** 菜单容器样式：fixed 定位跟随鼠标，zIndex 盖过画布/面板。 */
const menuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  padding: 4,
  background: "#fff",
  borderRadius: 8,
  boxShadow: "0 3px 10px rgba(0,0,0,0.15)",
};

/** 菜单近似尺寸：视口右/下边缘防溢出 clamp 用。 */
const MENU_WIDTH = 140;
const MENU_HEIGHT = 96;

export function NodeContextMenu(): JSX.Element | null {
  const graphRef = useWorkflowGraphContext();
  const { openUpgrade, openHistory } = useNodeUi();
  const [menu, setMenu] = useState<MenuState | undefined>(undefined);

  // 挂载 X6 右键事件（图实例在 WorkflowCanvas 挂载后已建；effect 依赖 ref 稳定，只挂一次）。
  useEffect(() => {
    const graph = graphRef.current;
    if (graph === null) {
      return;
    }
    const handleNodeContextMenu = ({
      node,
      e,
    }: {
      readonly node: Node;
      readonly e: { readonly clientX: number; readonly clientY: number; readonly preventDefault: () => void };
    }): void => {
      e.preventDefault(); // 阻止浏览器原生右键菜单
      const data = node.getData<EditorGraphNode | undefined>();
      if (data === undefined || data.type !== "subworkflow" || typeof data.params["template"] !== "string") {
        setMenu(undefined); // 非模板引用子工作流/其他节点：无升级/历史语义，关闭
        return;
      }
      setMenu({ x: e.clientX, y: e.clientY, nodeData: data });
    };
    const handleBlankContextMenu = (): void => setMenu(undefined);
    graph.on("node:contextmenu", handleNodeContextMenu);
    graph.on("blank:contextmenu", handleBlankContextMenu);
    return () => {
      graph.off("node:contextmenu", handleNodeContextMenu);
      graph.off("blank:contextmenu", handleBlankContextMenu);
    };
  }, [graphRef]);

  // 点击菜单外任意位置关闭（菜单自身点击 stopPropagation 阻断冒泡）。
  useEffect(() => {
    if (menu === undefined) {
      return;
    }
    const handleClick = (): void => setMenu(undefined);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menu]);

  if (menu === undefined) {
    return null;
  }

  const items: MenuProps["items"] = [
    { key: "upgrade", label: "升级版本" },
    { key: "history", label: "查看历史" },
  ];
  const handleMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "upgrade") {
      openUpgrade(menu.nodeData);
    }
    if (key === "history") {
      openHistory(menu.nodeData);
    }
    setMenu(undefined);
  };
  // 视口边缘防溢出：菜单靠近右/下边界时 clamp 到视口内。
  const left = Math.max(0, Math.min(menu.x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(menu.y, window.innerHeight - MENU_HEIGHT));

  return (
    <div
      style={{ ...menuStyle, left, top }}
      onClick={(event) => event.stopPropagation()}
    >
      <Menu items={items} onClick={handleMenuClick} />
    </div>
  );
}
