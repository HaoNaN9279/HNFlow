// 功能组消费（v0.3.1 T6）：AI 节点将 activeGroups（T5 引擎注入的可选 MergedGroups）
// 合并进工具集与 systemPrompt。抽独立模块保持 ai.ts ≤250 行；纯函数不依赖 ctx，便于单测。
// D1 决策：功能组工具未注册代码实现时仅注入描述不执行；v0.3.1 简化为跳过（不注入、模型不可见）。
import { resolveMcpTools } from "../ai/mcp-tools.js";
import { getTool } from "../ai/toolRegistry.js";
import type { HNFlowTool } from "../ai/types.js";
import type { MergedGroups } from "../groups/merge.js";
import type { McpServerPool } from "../mcp/pool.js";

/** 功能组互斥冲突 → 中文警告（T6）：规则路径 + 双方 constraint，结构化 data 携带 kind。 */
export function warnGroupConflicts(
  activeGroups: MergedGroups | undefined,
  warn: (msg: string, data?: unknown) => void,
): void {
  if (activeGroups === undefined || activeGroups.conflicts.length === 0) {
    return;
  }
  for (const conflict of activeGroups.conflicts) {
    warn(
      `功能组规则互斥：${conflict.rulePathA}（constraint: ${conflict.constraintA}）与 ${conflict.rulePathB}（constraint: ${conflict.constraintB}）`,
      { kind: "group_rule_conflict", ...conflict },
    );
  }
}

/** 追加功能组工具：fullName（已含命名空间前缀）查代码注册表，已注册用代码 handler；未注册跳过不抛错。 */
export function mergeGroupTools(
  baseTools: readonly HNFlowTool[],
  activeGroups: MergedGroups | undefined,
): HNFlowTool[] {
  if (activeGroups === undefined) {
    return [...baseTools];
  }
  const groupTools: HNFlowTool[] = [];
  for (const merged of activeGroups.tools) {
    const registered = getTool(merged.fullName);
    if (registered !== undefined) {
      groupTools.push(registered);
    }
  }
  return [...baseTools, ...groupTools];
}

/** 拼接 systemPrompt：节点 prompt 在前、activeAgent 文本在后，\n\n 分隔；两者皆无返回 undefined。 */
export function buildSystemPrompt(
  nodePrompt: string | undefined,
  activeAgent: MergedGroups["agent"],
): string | undefined {
  if (nodePrompt === undefined && activeAgent === undefined) {
    return undefined;
  }
  return [
    ...(nodePrompt === undefined ? [] : [nodePrompt]),
    ...(activeAgent === undefined ? [] : [`【功能组 Agent 身份】\n${activeAgent.text}`]),
  ].join("\n\n");
}

/** 默认 warn 出口：调用方未注入日志器时降级 console（ai.ts 注入节点 logger）。 */
function defaultWarn(msg: string, data?: unknown): void {
  console.warn(msg, data);
}

/**
 * 异步合并工具集（v0.4.2 D2）：代码工具注入（mergeGroupTools）+ activeGroups.mcps → MCP 工具发现，
 * 按 fullName 去重（base 在前优先）。AI 节点无组命名空间概念，MCP 工具 fullName = <mcpName>.<toolName>。
 */
export async function mergeGroupToolsAsync(
  baseTools: readonly HNFlowTool[],
  activeGroups: MergedGroups | undefined,
  mcpPool: McpServerPool | undefined,
  warn: (msg: string, data?: unknown) => void = defaultWarn,
): Promise<HNFlowTool[]> {
  const codeTools = mergeGroupTools(baseTools, activeGroups);
  const mcpTools = await resolveMcpTools(activeGroups, mcpPool, "", warn);
  const seen = new Set<string>();
  const merged: HNFlowTool[] = [];
  for (const tool of [...codeTools, ...mcpTools]) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    merged.push(tool);
  }
  return merged;
}
