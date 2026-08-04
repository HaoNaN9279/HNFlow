// 工具转换与命名空间：HNFlowTool → langchain tool，引用解析。
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { HNFlowTool } from "./types.js";

/** langchain 工具类型别名（DynamicStructuredTool/DynamicTool 的统一接口）。 */
export type ToolType = StructuredToolInterface;

/** 命名空间前缀拼接：namespace 为 undefined/空串时返回原名，否则拼接 "namespace.name"。 */
export function applyNamespace(toolName: string, namespace?: string): string {
  if (namespace === undefined || namespace === "") {
    return toolName;
  }
  return `${namespace}.${toolName}`;
}

/** 工具引用缺失错误：节点 params 引用了未注册的工具。 */
export class UnknownToolReferenceError extends Error {
  readonly name = "UnknownToolReferenceError";

  constructor(readonly missingName: string) {
    super(`unknown tool reference: "${missingName}"`);
  }
}

/**
 * 转换 HNFlowTool 为 langchain tool。
 * schema 用 tool.parameters；handler 直接调用 tool.handler。
 * name 已含命名空间（注册时经 applyNamespace），转换时原样保留。
 */
export function toLangChainTool(hfTool: HNFlowTool): ToolType {
  return tool(hfTool.handler, {
    name: hfTool.name,
    description: hfTool.description,
    schema: hfTool.parameters,
  });
}

/** 按引用名（完整名）从可用表解析工具；引用不存在抛 UnknownToolReferenceError。 */
export function resolveToolReferences(
  refs: readonly string[],
  available: ReadonlyMap<string, HNFlowTool>,
): HNFlowTool[] {
  const resolved: HNFlowTool[] = [];
  for (const ref of refs) {
    const hfTool = available.get(ref);
    if (hfTool === undefined) {
      throw new UnknownToolReferenceError(ref);
    }
    resolved.push(hfTool);
  }
  return resolved;
}
