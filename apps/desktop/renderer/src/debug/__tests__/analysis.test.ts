// debug/analysis.ts 执行数据分析纯函数单测（无 DOM 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/debug/__tests__/analysis.test.ts`。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { IpcLogEntry } from "../../../../src/shared/ipc.js";
import {
  computeNodeStats,
  estimateTokens,
  extractTokenUsage,
  hasLlmMessages,
  summarizeTokenBudget,
  type TokenBudgetSummary,
} from "../analysis.js";

function log(message: string, data?: unknown): IpcLogEntry {
  return { level: "info", message, data };
}

describe("computeNodeStats", () => {
  it("按耗时降序排行 + name 查找 + pct 占比（Math.round）", () => {
    const stats = computeNodeStats(
      { a: 600, b: 300, c: 100 },
      { a: "Success", b: "Success", c: "Success" },
      { a: "节点A", b: "节点B", c: "节点C" },
    );
    expect(stats.map((s) => s.nodeId)).toEqual(["a", "b", "c"]);
    expect(stats[0]?.durationMs).toBe(600);
    expect(stats.map((s) => s.pct)).toEqual([60, 30, 10]);
    expect(stats.map((s) => s.name)).toEqual(["节点A", "节点B", "节点C"]);
  });

  it("name 缺失回退 nodeId", () => {
    const stats = computeNodeStats({ a: 100 }, { a: "Success" }, {});
    expect(stats[0]).toEqual({ nodeId: "a", name: "a", durationMs: 100, pct: 100, suggestion: "" });
  });

  it("pct≥30 且 durationMs≥500 → 耗时建议（含 pct）", () => {
    const stats = computeNodeStats({ a: 700, b: 300 }, { a: "Success", b: "Success" }, { a: "A", b: "B" });
    expect(stats[0]?.suggestion).toBe("耗时占比 70%，建议拆分或并行");
    expect(stats[1]?.suggestion).toBe("");
  });

  it("pct 达阈值但耗时不足 500 → 无耗时建议", () => {
    const stats = computeNodeStats({ a: 450, b: 50 }, { a: "Success", b: "Success" }, { a: "A", b: "B" });
    expect(stats[0]?.pct).toBe(90);
    expect(stats[0]?.suggestion).toBe("");
  });

  it("Failed 节点 → 失败提示", () => {
    const stats = computeNodeStats({ a: 10 }, { a: "Failed" }, { a: "A" });
    expect(stats[0]?.suggestion).toBe("节点失败，检查执行错误");
  });

  it("总耗时为 0 → 全部 pct 0", () => {
    const stats = computeNodeStats({ a: 0, b: 0 }, { a: "Success", b: "Success" }, { a: "A", b: "B" });
    expect(stats.every((s) => s.pct === 0)).toBe(true);
  });

  it("空输入 → 空数组", () => {
    expect(computeNodeStats({}, {}, {})).toEqual([]);
  });
});

describe("extractTokenUsage", () => {
  it("data.kind=llm_message 提取 total_tokens 并求和", () => {
    const logs = [
      log("", { kind: "llm_message", message: "hi", tokenUsage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }),
      log("", { kind: "llm_message", message: "yo", tokenUsage: { total_tokens: 7 } }),
    ];
    expect(extractTokenUsage(logs)).toBe(22);
  });

  it("message 含 llm_message 也识别；嵌套形状取 totalTokens", () => {
    const logs = [log('llm_message {"text":"hi"}', { tokenUsage: { usage: { totalTokens: 42 } } })];
    expect(extractTokenUsage(logs)).toBe(42);
  });

  it("部分提取失败 → 只累计成功项（该条贡献 0）", () => {
    const logs = [
      log("", { kind: "llm_message", message: "a", tokenUsage: { total_tokens: 5 } }),
      log("", { kind: "llm_message", message: "b", tokenUsage: { prompt_tokens: 1 } }),
    ];
    expect(extractTokenUsage(logs)).toBe(5);
  });

  it("无 llm_message / tokenUsage 缺失 / 无匹配键 → undefined", () => {
    expect(extractTokenUsage([])).toBeUndefined();
    expect(extractTokenUsage([log("hello", { kind: "tool_call" })])).toBeUndefined();
    expect(extractTokenUsage([log("", { kind: "llm_message", message: "x" })])).toBeUndefined();
    expect(extractTokenUsage([log("", { kind: "llm_message", message: "x", tokenUsage: { prompt_tokens: 1 } })])).toBeUndefined();
  });

  it("tokenUsage 为数组 → 跳过（不深入数组内对象）", () => {
    const logs = [log("", { kind: "llm_message", message: "x", tokenUsage: [{ total_tokens: 99 }] })];
    expect(extractTokenUsage(logs)).toBeUndefined();
  });
});

describe("estimateTokens", () => {
  it("空字符串 → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("chars/3 向上取整（中文/英文混合）", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("你好世界")).toBe(2); // 4/3 → ceil = 2
  });
});

describe("hasLlmMessages", () => {
  it("含 llm_message（data.kind 或 message 含关键词）→ true", () => {
    expect(hasLlmMessages([log("", { kind: "llm_message", message: "hi" })])).toBe(true);
    expect(hasLlmMessages([log('llm_message {"text":"hi"}')])).toBe(true);
  });

  it("无 llm_message 日志 → false", () => {
    expect(hasLlmMessages([])).toBe(false);
    expect(hasLlmMessages([log("普通日志", { kind: "tool_call", toolName: "x" })])).toBe(false);
  });
});

describe("summarizeTokenBudget", () => {
  const usageLogs = [log("", { kind: "llm_message", message: "hello", tokenUsage: { total_tokens: 100 } })];
  const textOnlyLogs = [log("", { kind: "llm_message", message: "hello world" }), log("", { kind: "llm_message", message: "foobar" })];

  it("有 usage → estimated 用 usage 和", () => {
    const summary: TokenBudgetSummary = summarizeTokenBudget(usageLogs, 500);
    expect(summary).toEqual({ estimated: 100, budget: 500, overBudget: false });
  });

  it("无 usage → llm_message 文本字符估算和", () => {
    // "hello world" 11 字符 → ceil(11/3)=4；"foobar" 6 字符 → 2；合计 6
    expect(summarizeTokenBudget(textOnlyLogs, 100).estimated).toBe(6);
  });

  it("无 llm_message 日志 → estimated 0", () => {
    expect(summarizeTokenBudget([log("x")], 100).estimated).toBe(0);
  });

  it("estimated 超 budget → overBudget true", () => {
    const summary = summarizeTokenBudget(usageLogs, 90);
    expect(summary).toEqual({ estimated: 100, budget: 90, overBudget: true });
  });
});
