// 子图展开：把 subworkflow 节点还原为普通节点（反向 packageSubgraph）。
// 边界入边 in_<x> 还原到子图内 binding=workflow:params:<x> 的节点端口 x；
// 边界出边 out_<x> 还原到子图内输出端口 x 的节点；删除自动补的 __end 节点及其入边。
import type { Edge, Node, Workflow } from "../model/types.js";
import {
  findNodeByInputBinding,
  findNodeByOutputPortId,
  InvalidSubgraphSelectionError,
  isWorkflow,
} from "./shared.js";

export function expandSubgraph(workflow: Workflow, subNodeId: string): Workflow {
  const subNode = workflow.nodes.find((node) => node.id === subNodeId);
  if (subNode === undefined || subNode.type !== "subworkflow") {
    throw new InvalidSubgraphSelectionError(`节点 "${subNodeId}" 不是 subworkflow 节点`);
  }
  const paramsWorkflow = isWorkflow(subNode.params["subworkflow"]) ? subNode.params["subworkflow"] : undefined;
  const subWorkflow = subNode.subworkflow ?? paramsWorkflow;
  if (subWorkflow === undefined) {
    throw new InvalidSubgraphSelectionError(`节点 "${subNodeId}" 缺少 subworkflow 内容`);
  }
  const prefix = `${subNodeId}__`;

  // 子图节点还原：id 加前缀，删除自动补的 __end；还原打包时改写的输入端口 binding。
  const restoredNodes: Node[] = subWorkflow.nodes
    .filter((node) => node.id !== "__end")
    .map((node) => ({
      ...node,
      id: `${prefix}${node.id}`,
      inputs: node.inputs.map((port) =>
        port.binding === `workflow:params:${port.id}`
          ? { id: port.id, name: port.name, type: port.type, direction: port.direction }
          : port,
      ),
    }));

  // 子图内部边还原：id 加前缀，删除指向 __end 的边。
  const restoredEdges: Edge[] = subWorkflow.edges
    .filter((edge) => edge.sourceNodeId !== "__end" && edge.targetNodeId !== "__end")
    .map((edge) => ({
      ...edge,
      sourceNodeId: `${prefix}${edge.sourceNodeId}`,
      targetNodeId: `${prefix}${edge.targetNodeId}`,
    }));

  // 边界端口映射：subNode 端口 id → 子图内节点 id / 原始端口 id。
  // in_<x> 的原始端口 id 从 binding（workflow:params:<x>）提取，冲突端口（in_b_2）也可正确还原。
  const inputPortMap = new Map<string, { nodeId: string; portId: string }>();
  for (const port of subNode.inputs) {
    if (!port.id.startsWith("in_") || port.binding === undefined) continue;
    if (!port.binding.startsWith("workflow:params:")) continue;
    const x = port.binding.slice("workflow:params:".length);
    const nodeId = findNodeByInputBinding(subWorkflow, port.binding);
    if (nodeId !== undefined) inputPortMap.set(port.id, { nodeId, portId: x });
  }
  const outputPortMap = new Map<string, { nodeId: string; portId: string }>();
  for (const port of subNode.outputs) {
    const x = /^out_(.+)$/.exec(port.id)?.[1];
    if (x === undefined) continue;
    const nodeId = findNodeByOutputPortId(subWorkflow, x);
    if (nodeId !== undefined) outputPortMap.set(port.id, { nodeId, portId: x });
  }

  // 父图边：指向/来自 subNode 的边界边还原到子图节点，无法还原的丢弃。
  const remainingEdges: Edge[] = [];
  for (const edge of workflow.edges) {
    if (edge.targetNodeId === subNodeId) {
      const target = inputPortMap.get(edge.targetPortId);
      if (target !== undefined) {
        remainingEdges.push({
          ...edge,
          targetNodeId: `${prefix}${target.nodeId}`,
          targetPortId: target.portId,
        });
      }
      continue;
    }
    if (edge.sourceNodeId === subNodeId) {
      const source = outputPortMap.get(edge.sourcePortId);
      if (source !== undefined) {
        remainingEdges.push({
          ...edge,
          sourceNodeId: `${prefix}${source.nodeId}`,
          sourcePortId: source.portId,
        });
      }
      continue;
    }
    remainingEdges.push(edge);
  }

  return {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    nodes: [...workflow.nodes.filter((node) => node.id !== subNodeId), ...restoredNodes],
    edges: [...remainingEdges, ...restoredEdges],
    ...(workflow.globalVariables === undefined ? {} : { globalVariables: workflow.globalVariables }),
    ...(workflow.draftOf === undefined ? {} : { draftOf: workflow.draftOf }),
  };
}
