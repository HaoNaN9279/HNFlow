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

// ==== v0.9.6 工具上下文动态裁剪 ====
// 纯函数先例同本模块：不依赖 ctx 便于单测；parse 系列经错误构造器回调，
// 由 ai 节点统一抛 InvalidAIParamsError（同 ai-interrupt.ts 模式）。

/** 工具裁剪模式：all=全量；subset=toolFilter 白名单；auto=相关度排序 + 预算裁剪。 */
export type ToolFilterMode = "all" | "subset" | "auto";

/** 非法参数错误构造器：调用方（ai 节点）传入类型化错误类。 */
export type ParamsErrorCtor = new (params: unknown, reason: string) => Error;

/** 按模式切分工具：all/auto 原样返回；subset 仅保留 name ∈ filter 白名单（filter 缺省 → []）。 */
export function filterToolsByMode(
  tools: readonly HNFlowTool[],
  mode: ToolFilterMode,
  filter?: readonly string[],
): HNFlowTool[] {
  if (mode !== "subset") {
    return [...tools];
  }
  if (filter === undefined) {
    return [];
  }
  const allowed = new Set(filter);
  return tools.filter((tool) => allowed.has(tool.name));
}

/** 分词：按空白/标点切分 query，去重返回词集合（中文整句无分隔符时保持整词）。 */
function tokenize(query: string): ReadonlySet<string> {
  return new Set(query.split(/[\s\p{P}\p{S}]+/u).filter((term) => term.length > 0));
}

/** 工具与 query 相关度：分词后每词命中工具名权重 2、命中描述权重 1，累加。 */
export function relevanceScore(tool: HNFlowTool, query: string): number {
  let score = 0;
  for (const term of tokenize(query)) {
    if (tool.name.includes(term)) {
      score += 2;
    }
    if (tool.description.includes(term)) {
      score += 1;
    }
  }
  return score;
}

/** 按相关度降序取前 maxCount：分数 > 0 优先，不足补分数 = 0；maxCount ≤ 0 返回空。 */
export function selectRelevantTools(
  tools: readonly HNFlowTool[],
  query: string,
  maxCount: number,
): HNFlowTool[] {
  if (maxCount <= 0) {
    return [];
  }
  return tools
    .map((tool) => ({ tool, score: relevanceScore(tool, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount)
    .map((entry) => entry.tool);
}

/** 估算工具上下文 token：Σ ceil((name + description) 字符数 / 3)（v0.9.2 估算思路，name 计入）。 */
export function estimateToolsTokens(tools: readonly HNFlowTool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += Math.ceil((tool.name.length + tool.description.length) / 3);
  }
  return total;
}

/** 预算裁剪：估算超限时按相关度递减 maxCount 重选直到 ≤ budget 或空，返回裁剪后工具与裁掉数量。 */
export function enforceToolBudget(
  tools: readonly HNFlowTool[],
  budget: number,
  query: string,
): { readonly tools: HNFlowTool[]; readonly trimmed: number } {
  const original = [...tools];
  if (estimateToolsTokens(original) <= budget) {
    return { tools: original, trimmed: 0 };
  }
  for (let maxCount = original.length - 1; maxCount >= 0; maxCount -= 1) {
    const candidate = selectRelevantTools(original, query, maxCount);
    if (estimateToolsTokens(candidate) <= budget) {
      return { tools: candidate, trimmed: original.length - candidate.length };
    }
  }
  return { tools: [], trimmed: original.length };
}

/** execute 接线聚合：subset 白名单切分；auto 相关度排序；toolBudget 超限按相关度裁剪（trimmed 仅计预算裁掉数）。 */
export function applyToolContextPruning(
  tools: readonly HNFlowTool[],
  toolMode: ToolFilterMode | undefined,
  toolFilter: readonly string[] | undefined,
  toolBudget: number | undefined,
  query: string,
): { readonly tools: HNFlowTool[]; readonly trimmed: number } {
  let pruned = [...tools];
  if (toolMode === "subset") {
    pruned = filterToolsByMode(pruned, toolMode, toolFilter);
  } else if (toolMode === "auto") {
    pruned = selectRelevantTools(pruned, query, pruned.length);
  }
  if (toolBudget === undefined) {
    return { tools: pruned, trimmed: 0 };
  }
  return enforceToolBudget(pruned, toolBudget, query);
}

/** 解析 toolMode：缺省 "all"；非 all/subset/auto 抛错。 */
export function parseToolMode(value: unknown, InvalidError: ParamsErrorCtor): ToolFilterMode {
  if (value === undefined) {
    return "all";
  }
  if (value !== "all" && value !== "subset" && value !== "auto") {
    throw new InvalidError(value, `toolMode 非法: "${String(value)}"（支持 all/subset/auto）`);
  }
  return value;
}

/** 解析 toolFilter：可选字符串数组（subset 白名单）；非数组或含非字符串抛错。 */
export function parseToolFilter(
  value: unknown,
  InvalidError: ParamsErrorCtor,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new InvalidError(value, "toolFilter 必须是字符串数组");
  }
  for (const [index, ref] of value.entries()) {
    if (typeof ref !== "string") {
      throw new InvalidError(value, `toolFilter[${index}] 必须是字符串`);
    }
  }
  return value as string[];
}

/** 解析 toolBudget：可选正数（token 预算）；非数字/非有限/≤0 抛错。 */
export function parseToolBudget(value: unknown, InvalidError: ParamsErrorCtor): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new InvalidError(value, "toolBudget 必须是正数");
  }
  return value;
}
