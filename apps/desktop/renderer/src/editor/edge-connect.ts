// T7 连线校验纯逻辑：无 DOM/X6 依赖，可独立单测（bun test 直跑）。
//
// 校验规则组合（顺序即优先级）：
//  1. 方向（可选字段）：source 须为 out、target 须为 in；
//  2. 端口类型兼容：@core isPortCompatible，不兼容用 describePortMismatch 中文消息；
//  3. 目标输入端口未被占用（同一 targetNodeId:targetPortId 已有连线则拒绝）；
//  4. 禁止自连（source.nodeId === target.nodeId）；
//  5. 禁止成环（反向直连反查 + 简单可达性检查）。

import { describePortMismatch, isPortCompatible } from "@core/model/port-compat";
import type { Edge, PortDirection, PortType } from "@core/model/types";

/** 连线端点：nodeId/portId 由 parsePortCellId 还原，portType/direction 来自 @core Port。 */
export interface ConnectionEndpoint {
  readonly nodeId: string;
  readonly portId: string;
  readonly portType: PortType;
  readonly direction?: PortDirection;
}

/** 校验结果：ok=false 时 reason 为中文拒绝原因（X6 拒绝连线提示用）。 */
export interface ConnectionValidation {
  readonly ok: boolean;
  readonly reason?: string;
}

/** 边目标端口定位描述（错误消息里的"节点.端口"）。 */
export function describeEdgeTargets(edge: Edge): string {
  return `${edge.targetNodeId}.${edge.targetPortId}`;
}

/** 校验连线 source（输出端口）→ target（输入端口）；existingEdges 为当前已存在边。 */
export function validateConnection(
  source: ConnectionEndpoint,
  target: ConnectionEndpoint,
  existingEdges: readonly Edge[],
): ConnectionValidation {
  if (source.direction !== undefined && source.direction !== "out") {
    return { ok: false, reason: "连线方向错误：只能从输出端口开始连线" };
  }
  if (target.direction !== undefined && target.direction !== "in") {
    return { ok: false, reason: "连线方向错误：只能连接到输入端口" };
  }
  if (source.nodeId === target.nodeId) {
    return { ok: false, reason: "不能连接到自身" };
  }
  if (!isPortCompatible(source.portType, target.portType)) {
    const reason = describePortMismatch(source.portType, target.portType) ?? "端口类型不兼容";
    return { ok: false, reason };
  }
  const occupying = existingEdges.find(
    (edge) => edge.targetNodeId === target.nodeId && edge.targetPortId === target.portId,
  );
  if (occupying !== undefined) {
    return { ok: false, reason: `输入端口已连接：${describeEdgeTargets(occupying)}` };
  }
  const reverse = existingEdges.some(
    (edge) => edge.sourceNodeId === target.nodeId && edge.targetNodeId === source.nodeId,
  );
  if (reverse) {
    return { ok: false, reason: "已存在反向连线，不能形成环" };
  }
  if (createsCycle(source, target, existingEdges)) {
    return { ok: false, reason: "该连线会形成环，不允许连接" };
  }
  return { ok: true };
}

/** 可达性检查：target 已能到达 source 时，新增 source→target 会成环。 */
function createsCycle(source: ConnectionEndpoint, target: ConnectionEndpoint, edges: readonly Edge[]): boolean {
  const adjacency = new Map<string, readonly string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.sourceNodeId);
    adjacency.set(edge.sourceNodeId, next === undefined ? [edge.targetNodeId] : [...next, edge.targetNodeId]);
  }
  const visited = new Set<string>();
  const queue: string[] = [target.nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    if (current === source.nodeId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      queue.push(next);
    }
  }
  return false;
}
