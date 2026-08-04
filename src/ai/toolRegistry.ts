// 工具注册表：模块级 Map，AI 节点与测试共用。
// v0.2.0 无功能组概念，全部工具平铺注册；完整名（含命名空间前缀）作为唯一键。
import type { HNFlowTool } from "./types.js";

/** 重复注册同一工具名。 */
export class DuplicateToolError extends Error {
  readonly name = "DuplicateToolError";

  constructor(readonly toolName: string) {
    super(`tool already registered: "${toolName}"`);
  }
}

const tools = new Map<string, HNFlowTool>();

/** 注册工具：重名抛 DuplicateToolError。 */
export function registerTool(tool: HNFlowTool): void {
  if (tools.has(tool.name)) {
    throw new DuplicateToolError(tool.name);
  }
  tools.set(tool.name, tool);
}

/** 按完整名查询工具，未注册返回 undefined。 */
export function getTool(name: string): HNFlowTool | undefined {
  return tools.get(name);
}

/** 已注册工具快照（AI 节点解析工具引用用）。 */
export function availableTools(): ReadonlyMap<string, HNFlowTool> {
  return tools;
}

/** 清空注册表（测试隔离用）。 */
export function clearTools(): void {
  tools.clear();
}
