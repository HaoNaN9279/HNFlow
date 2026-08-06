// 编辑器图模型中间层：Workflow ↔ EditorGraph 双向纯函数转换。
// 用途：renderer 把 Workflow JSON 转成编辑器可渲染的图结构（含层级索引），编辑后转回 Workflow。
// 转换逻辑在核心库保持可测，不依赖 X6。
//
// 设计定案：
// - toEditorGraph 强校验（validateWorkflow，非法抛错含 errors.join），position 缺失补默认 {x:0,y:0}；
// - fromEditorGraph 只做结构还原、不做语义强校验（放行编辑器中间态；最终 saveWorkflow 走
//   serialization.toJSON 的 zod 校验兜底），结构完整性做基本防御（节点 id 非空、不重复）；
// - EditorGraph 可选携带图元信息（id/name/version）：Node.subworkflow 是完整 Workflow，
//   若中间层不留元信息则嵌套子图往返后 id/name/version 丢失、无法 deepEqual，故必须随图携带。
import type { Edge, Node, Port, Workflow } from "../model/types.js";
import { validateWorkflow } from "../model/validate.js";

/** 编辑器图：节点平铺 + 边复用 model Edge + 入口节点标记 + 图元信息（子图往返还原用）。 */
export interface EditorGraph {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly nodes: readonly EditorGraphNode[];
  readonly edges: readonly Edge[];
  readonly entryNodeId?: string; // start 节点（有则标）
}

/** 编辑器图节点：position 必填（toEditorGraph 缺失补默认坐标），subworkflow 递归嵌套。 */
export interface EditorGraphNode {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputs: readonly Port[];
  readonly outputs: readonly Port[];
  readonly position: { readonly x: number; readonly y: number };
  readonly subworkflow?: EditorGraph; // 嵌套层级（递归）
}

/** 从子图携带的图元信息恢复 meta；缺省回退父节点与父 version（防御编辑器手工构造图）。 */
function subworkflowMeta(
  graph: EditorGraph,
  parentNode: EditorGraphNode,
  parentVersion: string,
): { id: string; name: string; version: string } {
  return {
    id: graph.id ?? parentNode.id,
    name: graph.name ?? parentNode.name,
    version: graph.version ?? parentVersion,
  };
}

/**
 * Workflow → EditorGraph。
 * 先 validateWorkflow（非法抛错，消息含 errors.join；嵌套子图由校验器递归覆盖）；
 * 节点 position 缺失补默认 {x:0,y:0}；subworkflow 递归转换；
 * type === "start" 的节点标记 entryNodeId（无 start 则不标）。
 */
export function toEditorGraph(workflow: Workflow): EditorGraph {
  const result = validateWorkflow(workflow);
  if (!result.ok) {
    throw new Error(`Invalid workflow: ${result.errors.join("; ")}`);
  }
  const nodes = workflow.nodes.map(nodeToGraph);
  const entry = nodes.find((node) => node.type === "start");
  return {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    nodes,
    edges: workflow.edges,
    ...(entry === undefined ? {} : { entryNodeId: entry.id }),
  };
}

function nodeToGraph(node: Node): EditorGraphNode {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    params: node.params,
    inputs: node.inputs,
    outputs: node.outputs,
    position: node.position ?? { x: 0, y: 0 },
    ...(node.subworkflow === undefined ? {} : { subworkflow: toEditorGraph(node.subworkflow) }),
  };
}

/**
 * EditorGraph → Workflow（含子图递归还原）。
 * 顶层元信息取 meta 参数；子图元信息取图自带 id/name/version（缺省回退节点派生值）。
 * position 原样保留；不做语义强校验，仅做结构完整性防御（节点 id 非空、不重复）。
 */
export function fromEditorGraph(
  graph: EditorGraph,
  meta: { readonly id: string; readonly name: string; readonly version: string },
): Workflow {
  assertIntegrity(graph);
  return {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    nodes: graph.nodes.map((node) => nodeFromGraph(node, meta.version)),
    edges: graph.edges,
  };
}

function nodeFromGraph(node: EditorGraphNode, parentVersion: string): Node {
  const subworkflow =
    node.subworkflow === undefined
      ? undefined
      : fromEditorGraph(node.subworkflow, subworkflowMeta(node.subworkflow, node, parentVersion));
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    params: node.params,
    inputs: node.inputs,
    outputs: node.outputs,
    position: node.position,
    ...(subworkflow === undefined ? {} : { subworkflow }),
  };
}

/** 结构完整性基本防御：节点 id 非空且不重复（递归进入子图）。 */
function assertIntegrity(graph: EditorGraph): void {
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (node.id.trim() === "") {
      throw new Error("Invalid editor graph: 节点 id 为空");
    }
    if (seen.has(node.id)) {
      throw new Error(`Invalid editor graph: 节点 id 重复 "${node.id}"`);
    }
    seen.add(node.id);
    if (node.subworkflow !== undefined) {
      assertIntegrity(node.subworkflow);
    }
  }
}
