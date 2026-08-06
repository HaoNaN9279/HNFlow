// 节点路径格式化（v0.4.2 验收 5）：把 Engine 的 workflowId 父链 + 当前节点 id 格式化为人类可读路径。
// workflowId 结构：顶层引擎 = 根 workflow.id（无冒号）；子引擎 = 父workflowId:容器节点id（冒号分隔逐层嵌套）。
// 冒号分段中首段是根 workflow id 本身（不显示，统一用「顶层工作流」前缀表示），其余段是逐层容器节点 id；
// 当前节点 id 不在 workflowId 里（ctx.node.id 单独持有），单独传入。
// 每段经 resolveName 映射为节点名，映射不到回退原始 id（如子引擎内容器节点属父图、本引擎节点表查不到）。
export const PATH_SEPARATOR = " > ";
const ROOT_LABEL = "顶层工作流";

export function formatNodePath(
  workflowId: string,
  currentNodeId: string,
  resolveName: (id: string) => string | undefined,
): string {
  const segments = workflowId.split(":").filter((segment) => segment.length > 0);
  // 首段是根 workflow id（顶层工作流自身），不显示；其余段是逐层容器节点 id。
  const containerSegments = segments.slice(1);
  const pathSegments = [...containerSegments, currentNodeId]
    .filter((segment) => segment.length > 0)
    .map((id) => resolveName(id) ?? id);
  if (pathSegments.length === 0) return ROOT_LABEL;
  return `${ROOT_LABEL}${PATH_SEPARATOR}${pathSegments.join(PATH_SEPARATOR)}`;
}
