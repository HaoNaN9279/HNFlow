// debug/analysis.ts：执行数据分析纯函数（无 React/DOM 依赖，可独立单测）。
// 覆盖：节点耗时排行（computeNodeStats）、AI token 用量提取（extractTokenUsage）、文本 token 估算（estimateTokens）、预算汇总（summarizeTokenBudget）。
// IPC 边界类型从 shared/ipc.js 导入（renderer 侧只 import 类型，同 format.ts 先例）。

import type { IpcLogEntry } from "../../../src/shared/ipc.js";

/** 节点耗时统计条目：按耗时降序排行。 */
export interface NodeStat {
  readonly nodeId: string;
  readonly name: string;
  readonly durationMs: number;
  /** 占总耗时百分比（Math.round；总耗时为 0 则为 0）。 */
  readonly pct: number;
  readonly suggestion: string;
}

/** 节点耗时排行：按 durationMs 降序，附占比与优化建议（name 缺失回退 nodeId）。 */
export function computeNodeStats(
  nodeDurations: Record<string, number>,
  nodeStates: Record<string, string>,
  nodeNames: Record<string, string>,
): NodeStat[] {
  const entries = Object.entries(nodeDurations);
  const total = entries.reduce((sum, [, duration]) => sum + duration, 0);
  return entries
    .map(([nodeId, durationMs]) => {
      const pct = total === 0 ? 0 : Math.round((durationMs / total) * 100);
      let suggestion = "";
      if (pct >= 30 && durationMs >= 500) {
        suggestion = `耗时占比 ${pct}%，建议拆分或并行`;
      } else if (nodeStates[nodeId] === "Failed") {
        suggestion = "节点失败，检查执行错误";
      }
      return { nodeId, name: nodeNames[nodeId] ?? nodeId, durationMs, pct, suggestion };
    })
    .sort((a, b) => b.durationMs - a.durationMs);
}

/** token 用量递归提取：自身 total_tokens/totalTokens/total 数字命中即用；否则递归嵌套值（数组跳过；非对象返回 undefined）。 */
function findTotalTokens(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ["total_tokens", "totalTokens", "total"] as const) {
    const raw = record[key];
    if (typeof raw === "number") {
      return raw;
    }
  }
  for (const nested of Object.values(record)) {
    const found = findTotalTokens(nested);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** 单条日志是否 llm_message：message 含 "llm_message" 或 data.kind === "llm_message"。 */
function isLlmMessageEntry(entry: IpcLogEntry): boolean {
  if (entry.message.includes("llm_message")) {
    return true;
  }
  const data = entry.data;
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return (data as Readonly<Record<string, unknown>>)["kind"] === "llm_message";
}

/** 是否存在 llm_message 日志（分析面板「无 AI 调用」空态判断）。 */
export function hasLlmMessages(logs: readonly IpcLogEntry[]): boolean {
  return logs.some(isLlmMessageEntry);
}

/** 日志条目 tokenUsage 透传值（data 非对象/缺键返回 undefined）。 */
function tokenUsageOf(entry: IpcLogEntry): unknown {
  const data = entry.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  return (data as Readonly<Record<string, unknown>>)["tokenUsage"];
}

/** llm_message 消息文本：优先 data.message（结构化透传），回退 entry.message（message 含 llm_message 的序列化条目）。 */
function llmMessageText(entry: IpcLogEntry): string {
  const data = entry.data;
  if (typeof data === "object" && data !== null) {
    const message = (data as Readonly<Record<string, unknown>>)["message"];
    if (typeof message === "string") {
      return message;
    }
  }
  return entry.message;
}

/** 扫描 llm_message 日志提取 token 总用量：成功提取项求和；全部提取失败返回 undefined（未知，预算汇总走估算）。 */
export function extractTokenUsage(logs: readonly IpcLogEntry[]): number | undefined {
  let total: number | undefined;
  for (const entry of logs) {
    if (!isLlmMessageEntry(entry)) {
      continue;
    }
    const usage = findTotalTokens(tokenUsageOf(entry));
    if (usage !== undefined) {
      total = (total ?? 0) + usage;
    }
  }
  return total;
}

/** 文本 token 估算：chars/3 向上取整（中文/英文混合粗略；空字符串为 0）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** token 预算汇总结果：estimated 为用量和或文本估算和，overBudget 表示已超预算。 */
export interface TokenBudgetSummary {
  readonly estimated: number;
  readonly budget: number;
  readonly overBudget: boolean;
}

/** 汇总 token 预算：有 usage 用 usage 和；无 usage 用 llm_message 消息文本字符估算和（estimateTokens）。 */
export function summarizeTokenBudget(logs: readonly IpcLogEntry[], budget: number): TokenBudgetSummary {
  const usage = extractTokenUsage(logs);
  const estimated =
    usage !== undefined
      ? usage
      : logs.reduce((sum, entry) => (isLlmMessageEntry(entry) ? sum + estimateTokens(llmMessageText(entry)) : sum), 0);
  return { estimated, budget, overBudget: estimated > budget };
}
