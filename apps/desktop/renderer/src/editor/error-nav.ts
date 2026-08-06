// error-nav：错误节点路径解析与导航计划（v0.4.2 验收 5，纯函数，无 DOM/X6 依赖，可独立单测）。
//
// nodePath 格式（核心库 node-path.ts）：「顶层工作流 > 容器1名 > ... > 节点名」——
// 首段固定为根前缀「顶层工作流」（仅展示，不代表画布节点）；末段是失败叶子节点名；
// 中间是逐层容器节点名，resolveName 映射不到时容器段可能回退为原始节点 id。
//
// planErrorNavigation 从「当前打开的画布层」出发，沿路径逐层解析容器：
// - 叶子在当前层 → ok（containerNames 为空，直接定位）；
// - 容器逐层内嵌可进入 → ok（containerNames 为待进入的子工作流节点名序列）；
// - 层级断裂（容器非 subworkflow / 模板引用未载入 / 无内嵌子图）→ blocked（仅能定位容器入口）；
// - 路径段在当前层找不到 / 无有效段 → notFound。
// 务实范围（验收 5）：只匹配当前已打开的画布链；模板引用子层不深入（定位入口即可）。

import type { EditorGraph, EditorGraphNode } from "@core/editing/editor-graph";

/** 路径分隔符（与核心库 src/execution/node-path.ts 的 PATH_SEPARATOR 保持一致；renderer 不依赖 execution 模块）。 */
export const NODE_PATH_SEPARATOR = " > ";

/** 根前缀标签（核心库 ROOT_LABEL）：仅展示，不参与画布节点匹配。 */
const ROOT_LABEL = "顶层工作流";

/** 目标节点引用：id 供 X6 定位，name 供提示展示。 */
export interface ErrorTargetNode {
  readonly id: string;
  readonly name: string;
}

/** 导航计划：ok = 叶子可达；blocked = 层级断裂仅能定位入口；notFound = 路径无效/找不到。 */
export type ErrorNavPlan =
  | {
      /** 叶子可达：containerNames 为从当前层起需逐层进入的子工作流节点名（空 = 叶子就在当前层）。 */
      readonly kind: "ok";
      readonly containerNames: readonly string[];
      readonly leaf: ErrorTargetNode;
    }
  | {
      /** 层级断裂：只能定位 blocked 节点（当前层容器入口），无法继续深入。 */
      readonly kind: "blocked";
      readonly blocked: ErrorTargetNode;
    }
  | { readonly kind: "notFound" };

/** nodePath → 展示段（按分隔符切分、trim、去空段；含「顶层工作流」首段，仅展示用途）。 */
export function parseNodePath(nodePath: string): readonly string[] {
  return nodePath
    .split(NODE_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** 按节点名或原始 id 匹配当前层节点（容器段 resolveName 回退为原始 id 时按 id 兜底）。 */
function findNodeByNameOrId(graph: EditorGraph, key: string): EditorGraphNode | undefined {
  return graph.nodes.find((node) => node.name === key || node.id === key);
}

/** 容器可进入：子工作流节点且内嵌子图已载入（模板引用/无内容不可进入）。 */
function isEnterableContainer(node: EditorGraphNode): node is EditorGraphNode & { readonly subworkflow: EditorGraph } {
  return node.type === "subworkflow" && node.subworkflow !== undefined;
}

/**
 * 解析 nodePath → 导航计划（相对传入的当前层图）。
 * 末段是叶子，逐段前移的容器须在当前层按名/id 找到且可进入（内嵌子图），否则 blocked/notFound。
 */
export function planErrorNavigation(graph: EditorGraph, nodePath: string): ErrorNavPlan {
  const rawSegments = parseNodePath(nodePath);
  // 剥离开头固定的「顶层工作流」根前缀：它不是画布节点。
  const segments = rawSegments[0] === ROOT_LABEL ? rawSegments.slice(1) : rawSegments;
  const leafName = segments[segments.length - 1];
  if (leafName === undefined) {
    return { kind: "notFound" };
  }
  const containers = segments.slice(0, -1);
  let current = graph;
  const entered: string[] = [];
  for (const containerName of containers) {
    const container = findNodeByNameOrId(current, containerName);
    if (container === undefined) {
      return { kind: "notFound" };
    }
    if (!isEnterableContainer(container)) {
      return { kind: "blocked", blocked: { id: container.id, name: container.name } };
    }
    const sub = container.subworkflow;
    entered.push(containerName);
    current = sub;
  }
  const leaf = findNodeByNameOrId(current, leafName);
  if (leaf === undefined) {
    return { kind: "notFound" };
  }
  return { kind: "ok", containerNames: entered, leaf: { id: leaf.id, name: leaf.name } };
}
