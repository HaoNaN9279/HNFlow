// 图校验：环检测、端口类型匹配、边引用完整性。
import type { Node, Port, Workflow } from "./types.js";

/**
 * DFS（三色标记）检测有向图环。
 * 命中环时 path 给出完整环路径（节点 id 序列，从回边起点回到回边目标）。
 */
export function detectCycle(workflow: Workflow): { hasCycle: boolean; path: string[] } {
  const adj = new Map<string, string[]>();
  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=栈中 2=已完成
  for (const node of workflow.nodes) {
    adj.set(node.id, []);
    state.set(node.id, 0);
  }
  for (const edge of workflow.edges) {
    if (adj.has(edge.sourceNodeId) && adj.has(edge.targetNodeId)) {
      adj.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    }
  }

  const trail: string[] = [];
  let cycle: string[] | null = null;

  const visit = (id: string): void => {
    state.set(id, 1);
    trail.push(id);
    for (const next of adj.get(id) ?? []) {
      const nextState = state.get(next);
      if (nextState === 1) {
        cycle = [...trail.slice(trail.indexOf(next)), next];
        return;
      }
      if (nextState === 0) {
        visit(next);
        if (cycle !== null) return;
      }
    }
    trail.pop();
    state.set(id, 2);
  };

  for (const node of workflow.nodes) {
    if (state.get(node.id) === 0) {
      visit(node.id);
      if (cycle !== null) break;
    }
  }

  return cycle === null ? { hasCycle: false, path: [] } : { hasCycle: true, path: cycle };
}

function findPort(node: Node, portId: string): Port | undefined {
  return (
    node.inputs.find((port) => port.id === portId) ??
    node.outputs.find((port) => port.id === portId)
  );
}

/** 遍历边，sourcePort 与 targetPort 的 type 必须兼容（相等，或任一方为 "any"）。 */
export function validatePortTypes(workflow: Workflow): string[] {
  const errors: string[] = [];
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const edge of workflow.edges) {
    const sourceNode = nodesById.get(edge.sourceNodeId);
    const targetNode = nodesById.get(edge.targetNodeId);
    if (sourceNode === undefined || targetNode === undefined) continue;
    const sourcePort = findPort(sourceNode, edge.sourcePortId);
    const targetPort = findPort(targetNode, edge.targetPortId);
    if (sourcePort === undefined || targetPort === undefined) continue;
    if (
      sourcePort.type === targetPort.type ||
      sourcePort.type === "any" ||
      targetPort.type === "any"
    ) {
      continue;
    }
    errors.push(
      `edge ${edge.id}: type mismatch — "${sourceNode.name}.${sourcePort.name}" (${sourcePort.type}) 不能连接到 "${targetNode.name}.${targetPort.name}" (${targetPort.type})`,
    );
  }
  return errors;
}

/** 综合校验：环检测、端口类型匹配、边引用的节点/端口存在。 */
export function validateWorkflow(workflow: Workflow): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const cycle = detectCycle(workflow);
  if (cycle.hasCycle) {
    errors.push(`cycle detected: ${cycle.path.join(" -> ")}`);
  }

  errors.push(...validatePortTypes(workflow));

  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const edge of workflow.edges) {
    const sourceNode = nodesById.get(edge.sourceNodeId);
    if (sourceNode === undefined) {
      errors.push(`edge ${edge.id}: 源节点 "${edge.sourceNodeId}" 不存在`);
      continue;
    }
    if (findPort(sourceNode, edge.sourcePortId) === undefined) {
      errors.push(`edge ${edge.id}: 节点 "${edge.sourceNodeId}" 上不存在源端口 "${edge.sourcePortId}"`);
    }
    const targetNode = nodesById.get(edge.targetNodeId);
    if (targetNode === undefined) {
      errors.push(`edge ${edge.id}: 目标节点 "${edge.targetNodeId}" 不存在`);
      continue;
    }
    if (findPort(targetNode, edge.targetPortId) === undefined) {
      errors.push(`edge ${edge.id}: 节点 "${edge.targetNodeId}" 上不存在目标端口 "${edge.targetPortId}"`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
