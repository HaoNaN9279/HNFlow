// 端口命名约定（T7 连线校验依赖，勿改动）：
// - X6 port id = `${nodeId}:${portId}`；in 组靠左、out 组靠右。
// - 连线事件里 source/target 的 port 即该全量 id，用 parsePortCellId 还原 nodeId/portId。

export const PORT_ID_SEPARATOR = ":";

/** 画布内二维坐标（X6 本地坐标，非屏幕像素）。 */
export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

/** port 全量 id = `${nodeId}:${portId}`（T7 依赖的命名约定）。 */
export function toPortCellId(nodeId: string, portId: string): string {
  return `${nodeId}${PORT_ID_SEPARATOR}${portId}`;
}

/** 从 port 全量 id 还原 nodeId/portId；格式非法（无分隔符/空段）返回 undefined。 */
export function parsePortCellId(
  portCellId: string,
): { readonly nodeId: string; readonly portId: string } | undefined {
  const sep = portCellId.indexOf(PORT_ID_SEPARATOR);
  if (sep <= 0 || sep === portCellId.length - 1) {
    return undefined;
  }
  return { nodeId: portCellId.slice(0, sep), portId: portCellId.slice(sep + 1) };
}
