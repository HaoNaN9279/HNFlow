// 不可变深拷贝公共工具（含嵌套 subworkflow）。
// 供断点快照（runstate-persist）与编辑态草稿（editing）共用，消除两份重复实现。
import type { Edge, Node, Port, Workflow } from "../model/types.js";

/** 不可变深拷贝（含嵌套 subworkflow 递归、globalVariables、position 复制）。 */
export function deepCopyWorkflow(workflow: Workflow): Workflow {
  const copy: Workflow = {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    nodes: workflow.nodes.map(deepCopyNode),
    edges: workflow.edges.map(deepCopyEdge),
  };
  return workflow.globalVariables === undefined
    ? copy
    : { ...copy, globalVariables: deepCopyRecord(workflow.globalVariables) };
}

/** 不可变深拷贝任意 Record<string, unknown>（数组与嵌套对象递归）。 */
export function deepCopyRecord(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    copy[key] = deepCopyValue(record[key]);
  }
  return copy;
}

function deepCopyNode(node: Node): Node {
  const copy: Node = {
    id: node.id,
    type: node.type,
    name: node.name,
    params: deepCopyRecord(node.params),
    inputs: node.inputs.map(deepCopyPort),
    outputs: node.outputs.map(deepCopyPort),
  };
  const withPosition =
    node.position === undefined ? copy : { ...copy, position: { ...node.position } };
  return node.subworkflow === undefined
    ? withPosition
    : { ...withPosition, subworkflow: deepCopyWorkflow(node.subworkflow) };
}

function deepCopyPort(port: Port): Port {
  return {
    id: port.id,
    name: port.name,
    type: port.type,
    direction: port.direction,
    ...(port.binding === undefined ? {} : { binding: port.binding }),
  };
}

function deepCopyEdge(edge: Edge): Edge {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    sourcePortId: edge.sourcePortId,
    targetNodeId: edge.targetNodeId,
    targetPortId: edge.targetPortId,
  };
}

function deepCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepCopyValue);
  }
  if (isPlainObject(value)) {
    return deepCopyRecord(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
