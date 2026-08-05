// 核心引擎版本兼容校验（v0.3.2 T8）：功能组 requiresCoreVersion 与当前核心引擎版本匹配。
// CORE_VERSION 独立常量：对齐发布版本（package.json 为源码版本 0.1.0，两者不同步，故不依赖）。
import { supportsRange } from "../groups/resolve.js";

/** 核心引擎版本：对齐发布版本 v0.3.2（独立常量，不依赖 package.json 的 0.1.0）。 */
export const CORE_VERSION = "0.3.2";

/** 校验功能组 requiresCoreVersion 与当前核心引擎兼容。 */
export function assertCoreCompatible(
  requiresCoreVersion: string | undefined,
  options: { readonly allowIncompatible?: boolean; readonly guid: string; readonly version: string },
): void {
  if (requiresCoreVersion === undefined) return; // 无要求即兼容
  if (supportsRange(requiresCoreVersion, CORE_VERSION)) return;
  const message = `功能组 ${options.guid}@${options.version} 要求核心引擎 ${requiresCoreVersion}，当前引擎 ${CORE_VERSION}，不兼容（可用 allowIncompatibleGroups 开启宽松模式）`;
  if (options.allowIncompatible === true) {
    console.warn(`警告:${message}`);
    return;
  }
  throw new Error(message);
}
