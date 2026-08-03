// 序列化边界：Workflow ↔ WorkflowJSON（zod 校验）。
// zod optional 字段输出带 `| undefined`，与 types.ts 的 exactOptionalPropertyTypes 契约不符，
// 因此 fromJSON 显式重建为 readonly Workflow（运行时值本身不含 undefined）。
import { workflowSchema, type WorkflowJSON } from "../model/schemas.js";
import type { Edge, Node, Port, Workflow } from "../model/types.js";
import type { ZodError } from "zod";

type PortJSON = WorkflowJSON["nodes"][number]["inputs"][number];
type NodeJSON = WorkflowJSON["nodes"][number];
type EdgeJSON = WorkflowJSON["edges"][number];

/** zod issue.path（PropertyKey[]）→ "a.b.c"（数字索引转字符串）。 */
function formatIssuePath(path: PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

function describeIssues(error: ZodError): string[] {
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
}

/** 校验并返回 WorkflowJSON；失败抛错，消息含 zod issue 路径与消息。 */
export function toJSON(workflow: Workflow): WorkflowJSON {
  const result = workflowSchema.safeParse(workflow);
  if (!result.success) {
    throw new Error(`Invalid workflow: ${describeIssues(result.error).join("; ")}`);
  }
  return result.data;
}

/** 解析 unknown JSON 为 Workflow；失败抛错，消息汇总所有 zod issue。 */
export function fromJSON(json: unknown): Workflow {
  const result = workflowSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid workflow JSON: ${describeIssues(result.error).join("; ")}`);
  }
  const data = result.data;
  return {
    id: data.id,
    name: data.name,
    version: data.version,
    nodes: data.nodes.map(nodeFromJSON),
    edges: data.edges.map(edgeFromJSON),
    ...(data.globalVariables === undefined ? {} : { globalVariables: data.globalVariables }),
    ...(data.draftOf === undefined ? {} : { draftOf: data.draftOf }),
  };
}

/** 序列化为 2 空格缩进的 JSON 字符串。 */
export function serialize(workflow: Workflow): string {
  return JSON.stringify(toJSON(workflow), null, 2);
}

/** 解析 JSON 文本为 Workflow；文本非法 JSON 时抛清晰错误。 */
export function deserialize(text: string): Workflow {
  try {
    const parsed: unknown = JSON.parse(text);
    return fromJSON(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid workflow JSON text: ${error.message}`);
    }
    throw error;
  }
}

function portFromJSON(port: PortJSON): Port {
  return {
    id: port.id,
    name: port.name,
    type: port.type,
    direction: port.direction,
    ...(port.binding === undefined ? {} : { binding: port.binding }),
  };
}

function nodeFromJSON(node: NodeJSON): Node {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    params: node.params,
    inputs: node.inputs.map(portFromJSON),
    outputs: node.outputs.map(portFromJSON),
    ...(node.position === undefined ? {} : { position: node.position }),
    ...(node.subworkflow === undefined ? {} : { subworkflow: fromJSON(node.subworkflow) }),
  };
}

function edgeFromJSON(edge: EdgeJSON): Edge {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    sourcePortId: edge.sourcePortId,
    targetNodeId: edge.targetNodeId,
    targetPortId: edge.targetPortId,
  };
}
