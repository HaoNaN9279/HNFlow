// 子图变换共享单元：错误类、结果类型、内部 helpers。
import type { Node, Workflow } from "../model/types.js";

/** 子图选择非法：空集 / 单节点 / id 不在图中 / 展开目标不是 subworkflow。 */
export class InvalidSubgraphSelectionError extends Error {
  readonly name = "InvalidSubgraphSelectionError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface PackageSubgraphResult {
  readonly workflow: Workflow;
  readonly subNodeId: string;
  readonly subWorkflow: Workflow;
}

export function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    "version" in value &&
    "nodes" in value &&
    "edges" in value
  );
}

/** 子图内找到 binding 匹配的输入端口所属节点 id。 */
export function findNodeByInputBinding(subWorkflow: Workflow, binding: string): string | undefined {
  for (const node of subWorkflow.nodes) {
    if (node.inputs.some((port) => port.binding === binding)) return node.id;
  }
  return undefined;
}

/** 子图内找到输出端口 id 匹配的节点 id。 */
export function findNodeByOutputPortId(subWorkflow: Workflow, portId: string): string | undefined {
  for (const node of subWorkflow.nodes) {
    if (node.outputs.some((port) => port.id === portId)) return node.id;
  }
  return undefined;
}

/** 选中节点 position 均值；全部无 position 返回 undefined。 */
export function meanPosition(nodes: readonly Node[]): { x: number; y: number } | undefined {
  const positions = nodes
    .map((node) => node.position)
    .filter((position): position is { x: number; y: number } => position !== undefined);
  if (positions.length === 0) return undefined;
  const sum = positions.reduce(
    (acc, position) => ({ x: acc.x + position.x, y: acc.y + position.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / positions.length, y: sum.y / positions.length };
}

/** 端口 id 冲突计数：base 首次用 base，后续追加 _2/_3 后缀。 */
export function uniquePortId(base: string, counts: Map<string, number>): string {
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}_${count + 1}`;
}
