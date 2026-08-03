// 子图打包：把一段节点折叠为单个 subworkflow 节点。
// 边界入边生成 in_<x> 输入端口（binding workflow:params:<x>），子图内目标端口 binding 同步改写；
// 边界出边生成 out_<x> 输出端口；选中集无 end 节点时自动补 __end 并连无出边节点。
import { randomUUID } from "node:crypto";
import type { Edge, Node, Port, Workflow } from "../model/types.js";
import {
  InvalidSubgraphSelectionError,
  meanPosition,
  uniquePortId,
  type PackageSubgraphResult,
} from "./shared.js";

export function packageSubgraph(
  workflow: Workflow,
  nodeIds: readonly string[],
): PackageSubgraphResult {
  if (nodeIds.length === 0) {
    throw new InvalidSubgraphSelectionError("nodeIds 不能为空");
  }
  if (nodeIds.length < 2) {
    throw new InvalidSubgraphSelectionError(`nodeIds 至少需要 2 个节点，当前 ${nodeIds.length} 个`);
  }
  const selectedIds = new Set(nodeIds);
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const id of nodeIds) {
    if (!nodeById.has(id)) {
      throw new InvalidSubgraphSelectionError(`节点 "${id}" 不在 workflow 中`);
    }
  }

  const internalEdges = workflow.edges.filter(
    (edge) => selectedIds.has(edge.sourceNodeId) && selectedIds.has(edge.targetNodeId),
  );
  const incomingEdges = workflow.edges.filter(
    (edge) => selectedIds.has(edge.targetNodeId) && !selectedIds.has(edge.sourceNodeId),
  );
  const outgoingEdges = workflow.edges.filter(
    (edge) => selectedIds.has(edge.sourceNodeId) && !selectedIds.has(edge.targetNodeId),
  );

  // 边界边 → 自动端口 id 映射（按边 id 记录，冲突追加后缀）。
  const inputPortIds = new Map<string, string>();
  const inputCounts = new Map<string, number>();
  for (const edge of incomingEdges) {
    inputPortIds.set(edge.id, uniquePortId(`in_${edge.targetPortId}`, inputCounts));
  }
  const outputPortIds = new Map<string, string>();
  const outputCounts = new Map<string, number>();
  for (const edge of outgoingEdges) {
    outputPortIds.set(edge.id, uniquePortId(`out_${edge.sourcePortId}`, outputCounts));
  }

  // 子工作流节点自动输入端口：信息取自目标端口，binding 指向 workflow:params:<targetPortId>。
  const autoInputs: Port[] = incomingEdges.map((edge) => {
    const targetNode = nodeById.get(edge.targetNodeId);
    const targetPort = targetNode?.inputs.find((port) => port.id === edge.targetPortId);
    return {
      id: inputPortIds.get(edge.id) ?? `in_${edge.targetPortId}`,
      name: targetPort?.name ?? edge.targetPortId,
      type: targetPort?.type ?? "any",
      direction: "in",
      binding: `workflow:params:${edge.targetPortId}`,
    };
  });
  const autoOutputs: Port[] = outgoingEdges.map((edge) => {
    const sourceNode = nodeById.get(edge.sourceNodeId);
    const sourcePort = sourceNode?.outputs.find((port) => port.id === edge.sourcePortId);
    return {
      id: outputPortIds.get(edge.id) ?? `out_${edge.sourcePortId}`,
      name: sourcePort?.name ?? edge.sourcePortId,
      type: sourcePort?.type ?? "any",
      direction: "out",
    };
  });

  // 子图节点：被外部入边指向的输入端口 binding 改写为 workflow:params:<portId>。
  const rewrittenTargets = new Set(incomingEdges.map((edge) => edge.targetPortId));
  const subNodes: Node[] = nodeIds.map((id) => {
    const node = nodeById.get(id);
    if (node === undefined) {
      throw new InvalidSubgraphSelectionError(`节点 "${id}" 不在 workflow 中`);
    }
    const inputs = node.inputs.map((port) =>
      rewrittenTargets.has(port.id) ? { ...port, binding: `workflow:params:${port.id}` } : port,
    );
    return { ...node, inputs };
  });

  // 自动补 end：无 end 节点时新增，无出边选中节点连到 __end。
  let autoEdges: Edge[] = [];
  const autoEnd: Node | undefined = subNodes.some((node) => node.type === "end")
    ? undefined
    : {
        id: "__end",
        name: "结束",
        type: "end",
        params: {},
        inputs: [
          { id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" },
        ],
        outputs: [],
      };
  if (autoEnd !== undefined) {
    let edgeIndex = 0;
    for (const node of subNodes) {
      const hasOutgoing = workflow.edges.some((edge) => edge.sourceNodeId === node.id);
      if (hasOutgoing) continue;
      const firstOutput = node.outputs[0];
      if (firstOutput === undefined) continue;
      autoEdges = [
        ...autoEdges,
        {
          id: `__edge_${edgeIndex}`,
          sourceNodeId: node.id,
          sourcePortId: firstOutput.id,
          targetNodeId: "__end",
          targetPortId: "in",
        },
      ];
      edgeIndex += 1;
    }
  }

  const subWorkflow: Workflow = {
    id: `sub-${workflow.id}`,
    name: "子工作流",
    version: workflow.version,
    nodes: autoEnd === undefined ? subNodes : [...subNodes, autoEnd],
    edges: autoEdges.length === 0 ? internalEdges : [...internalEdges, ...autoEdges],
  };

  const subNodeId = `sub_${randomUUID().slice(0, 8)}`;
  const dependencies = [...new Set(subWorkflow.nodes.map((node) => node.type))];
  const position = meanPosition(subNodes);
  const subNode: Node = {
    id: subNodeId,
    type: "subworkflow",
    name: "子工作流",
    params: { subworkflow: subWorkflow, dependencies },
    inputs: autoInputs,
    outputs: [...autoOutputs, { id: "out", name: "结果", type: "any", direction: "out" }],
    ...(position === undefined ? {} : { position }),
    subworkflow: subWorkflow,
  };

  // 新父图：移除选中节点与内部边，边界边改指 subNode 对应端口。
  const rewrittenEdges = workflow.edges.map((edge) => {
    if (selectedIds.has(edge.targetNodeId) && !selectedIds.has(edge.sourceNodeId)) {
      return {
        ...edge,
        targetNodeId: subNodeId,
        targetPortId: inputPortIds.get(edge.id) ?? `in_${edge.targetPortId}`,
      };
    }
    if (selectedIds.has(edge.sourceNodeId) && !selectedIds.has(edge.targetNodeId)) {
      return {
        ...edge,
        sourceNodeId: subNodeId,
        sourcePortId: outputPortIds.get(edge.id) ?? `out_${edge.sourcePortId}`,
      };
    }
    return edge;
  });
  const parentEdges = rewrittenEdges.filter(
    (edge) => !(selectedIds.has(edge.sourceNodeId) && selectedIds.has(edge.targetNodeId)),
  );
  const parentNodes = [...workflow.nodes.filter((node) => !selectedIds.has(node.id)), subNode];

  return {
    workflow: {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      nodes: parentNodes,
      edges: parentEdges,
      ...(workflow.globalVariables === undefined ? {} : { globalVariables: workflow.globalVariables }),
      ...(workflow.draftOf === undefined ? {} : { draftOf: workflow.draftOf }),
    },
    subNodeId,
    subWorkflow,
  };
}
