// 端口类型兼容规则：连线时校验输出端口类型与输入端口类型是否兼容。
// 供编辑器实时拒绝不匹配连线；纯函数、无副作用、无外部依赖。
import type { PortType } from "./types.js";

/**
 * 判断输出端口类型 sourceType 是否能连接到输入端口类型 targetType。
 * 规则：any 兼容一切；同类型兼容（string↔string 等）；其余拒绝。
 */
export function isPortCompatible(sourceType: PortType, targetType: PortType): boolean {
  return (
    sourceType === "any" ||
    targetType === "any" ||
    sourceType === targetType
  );
}

/** 不兼容时返回中文错误消息（source → target 顺序）；兼容返回 undefined。 */
export function describePortMismatch(sourceType: PortType, targetType: PortType): string | undefined {
  if (isPortCompatible(sourceType, targetType)) return undefined;
  return `端口类型不兼容：${sourceType} → ${targetType}`;
}
