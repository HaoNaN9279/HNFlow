// AnalysisPanel：调试面板「分析」tab（v0.9.2）——节点耗时排行 + AI token 预算展示。
// - 数据源 RunDebugInfo（nodeDurations/nodeStates/logs），节点名从当前画布图映射（缺失回退 nodeId）；
// - 耗时排行复用 debug/analysis.ts computeNodeStats；token 预算复用 summarizeTokenBudget + hasLlmMessages；
// - 样式沿用 DebugPanel 内联风格（antd 色板：warning #fa8c16 / error #ff4d4f / 次要灰 #8c8c8c）。

import type { CSSProperties } from "react";
import type { RunDebugInfo } from "../../../src/shared/ipc.js";
import { useEditor } from "../editor/state.js";
import { computeNodeStats, hasLlmMessages, summarizeTokenBudget } from "../debug/analysis.js";

/** 默认 token 预算（≈10 万 token，覆盖典型本地模型上下文窗口；仅展示用）。 */
const TOKEN_BUDGET_DEFAULT = 100_000;

const emptyStyle: CSSProperties = { color: "#8c8c8c", fontSize: 12 };
const sectionTitleStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: "#262626" };
const thStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: "#8c8c8c",
  textAlign: "left",
  padding: "4px 8px",
};
const tdStyle: CSSProperties = { fontSize: 12, padding: "4px 8px", wordBreak: "break-all" };

/** 节点耗时排行表：表头 + 数据行（失败节点名红色，建议非空黄色）。 */
function DurationTable({ debug }: { readonly debug: RunDebugInfo }): JSX.Element {
  const { state } = useEditor();
  const nodeNames: Record<string, string> = {};
  for (const node of state.graph.nodes) {
    nodeNames[node.id] = node.name;
  }
  const stats = computeNodeStats(debug.nodeDurations ?? {}, debug.nodeStates, nodeNames);
  if (stats.length === 0) {
    return <span style={emptyStyle}>无节点耗时数据</span>;
  }
  return (
    <div>
      <div style={{ display: "flex" }}>
        <span style={{ ...thStyle, width: 120 }}>节点</span>
        <span style={{ ...thStyle, width: 70 }}>耗时 ms</span>
        <span style={{ ...thStyle, width: 50 }}>占比</span>
        <span style={{ ...thStyle, flex: 1 }}>建议</span>
      </div>
      {stats.map((stat) => (
        <div key={stat.nodeId} style={{ display: "flex", borderTop: "1px solid #f0f0f0" }}>
          <span style={{ ...tdStyle, width: 120, ...(debug.nodeStates[stat.nodeId] === "Failed" ? { color: "#ff4d4f" } : {}) }}>
            {stat.name}
          </span>
          <span style={{ ...tdStyle, width: 70 }}>{stat.durationMs}</span>
          <span style={{ ...tdStyle, width: 50 }}>{stat.pct}%</span>
          <span style={{ ...tdStyle, flex: 1, ...(stat.suggestion === "" ? {} : { color: "#fa8c16" }) }}>{stat.suggestion}</span>
        </div>
      ))}
    </div>
  );
}

/** Token 预算区：估算用量/预算对比；超预算红色警告；无 AI 调用显示空态。 */
function TokenBudgetSection({ debug }: { readonly debug: RunDebugInfo }): JSX.Element {
  if (!hasLlmMessages(debug.logs)) {
    return <span style={emptyStyle}>本次运行无 AI 调用</span>;
  }
  const budget = summarizeTokenBudget(debug.logs, TOKEN_BUDGET_DEFAULT);
  return (
    <div style={{ fontSize: 12 }}>
      <span>
        Token 估算 {budget.estimated} / 预算 {budget.budget}
      </span>
      {budget.overBudget && <span style={{ color: "#ff4d4f", marginLeft: 8 }}>已超预算</span>}
    </div>
  );
}

/** 分析面板：两区块（耗时排行 / token 预算），数据来自最近一次运行 RunDebugInfo。 */
export function AnalysisPanel({ debug }: { readonly debug: RunDebugInfo }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={sectionTitleStyle}>耗时排行</span>
        <DurationTable debug={debug} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={sectionTitleStyle}>Token 预算</span>
        <TokenBudgetSection debug={debug} />
      </div>
    </div>
  );
}
