// DebugPanel 的 tab 子组件（T3，与主面板同目录拆分，保持 DebugPanel.tsx ≤250 行）。
// 导出 LogsTab（执行日志）/ VarsTab（变量）/ NodesTab（节点状态）及其展示辅助。
// - 日志定位：浅层提取 message 内 `node:<id>`，可点击直达（onLocate，主面板浅层定位 centerCell + select）；
// - 节点状态行点击直达走 onLocate（主面板实现浅层定位 centerCell + select）。

import type { CSSProperties } from "react";
import { Badge, Button, Collapse, Segmented } from "antd";
import type { DebugContextSnapshot, DebugNodeStatus, IpcLogEntry, RunDebugInfo } from "../../../src/shared/ipc.js";
import { useEditor } from "../editor/state.js";
import {
  filterLogsByLevel,
  flattenSnapshotNodes,
  logLevelColor,
  nodeStatusMeta,
  summarizeValue,
  type LogLevelFilter,
} from "../debug/format.js";

const emptyStyle: CSSProperties = { color: "#8c8c8c", fontSize: 12 };

/** 从日志 message 浅层提取 `node:<id>` 引用（引擎日志约定格式；供节点直达定位）。 */
const NODE_REF_RE = /node:([A-Za-z0-9_-]+)/;
function extractNodeRef(message: string): string | undefined {
  return NODE_REF_RE.exec(message)?.[1];
}

/** 键值列表：key + 值单行摘要（变量 tab 复用）。 */
function KVList({ data }: { readonly data: Readonly<Record<string, unknown>> }): JSX.Element {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <span style={emptyStyle}>无变量</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "#595959", fontSize: 12, flexShrink: 0 }}>{key}</span>
          <span style={{ fontSize: 12, wordBreak: "break-all" }}>{summarizeValue(value, 200)}</span>
        </div>
      ))}
    </div>
  );
}

/** 执行日志 tab：级别过滤（Segmented）+ 色点 + message + data 摘要 + 节点上下文直达。 */
export function LogsTab({
  logs,
  level,
  onLevelChange,
  onLocate,
}: {
  readonly logs: readonly IpcLogEntry[];
  readonly level: LogLevelFilter;
  readonly onLevelChange: (level: LogLevelFilter) => void;
  readonly onLocate: (nodeId: string) => void;
}): JSX.Element {
  const filtered = filterLogsByLevel(logs, level);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Segmented
        size="small"
        value={level}
        onChange={(value) => onLevelChange(value as LogLevelFilter)}
        options={[
          { label: "全部", value: "all" },
          { label: "info", value: "info" },
          { label: "warn", value: "warn" },
          { label: "error", value: "error" },
        ]}
      />
      {filtered.length === 0 ? (
        <span style={emptyStyle}>暂无日志</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
          {filtered.map((log, index) => {
            const nodeRef = extractNodeRef(log.message);
            return (
              <div key={index} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    marginTop: 5,
                    borderRadius: "50%",
                    background: logLevelColor(log.level),
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, wordBreak: "break-all" }}>{log.message}</div>
                  {log.data !== undefined && (
                    <div style={{ color: "#8c8c8c", fontSize: 12, wordBreak: "break-all" }}>
                      data: {summarizeValue(log.data, 120)}
                    </div>
                  )}
                  {nodeRef !== undefined && (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: "auto", fontSize: 12 }}
                      title="点击直达节点"
                      onClick={() => onLocate(nodeRef)}
                    >
                      节点: {nodeRef}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 变量 tab：全局/工作流/节点三段 Collapse，值长折叠展示。 */
export function VarsTab({ snapshot }: { readonly snapshot: DebugContextSnapshot }): JSX.Element {
  const nodeItems = flattenSnapshotNodes(snapshot);
  return (
    <Collapse
      size="small"
      items={[
        { key: "global", label: "全局变量", children: <KVList data={snapshot.global} /> },
        { key: "workflow", label: "工作流变量", children: <KVList data={snapshot.workflow} /> },
        {
          key: "node",
          label: `节点变量（${nodeItems.length}）`,
          children:
            nodeItems.length === 0 ? (
              <span style={emptyStyle}>暂无节点变量</span>
            ) : (
              <Collapse
                size="small"
                items={nodeItems.map((item) => ({ key: item.key, label: item.nodeId, children: <KVList data={item.variables} /> }))}
              />
            ),
        },
      ]}
    />
  );
}

/** 节点行样式：Failed 红边框/浅红底，WaitingForHuman 橙边框/浅橙底，其余中性。 */
function nodeRowStyle(status: DebugNodeStatus): CSSProperties {
  const highlight =
    status === "Failed"
      ? { background: "#fff1f0", borderColor: "#ffccc7" }
      : status === "WaitingForHuman"
        ? { background: "#fff7e6", borderColor: "#ffd591" }
        : {};
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    borderRadius: 6,
    cursor: "pointer",
    border: "1px solid #f0f0f0",
    ...highlight,
  };
}

/** 节点状态 tab：工作流全部节点（状态徽标 + 输出摘要），点击行直达画布节点。 */
export function NodesTab({
  runResult,
  onLocate,
}: {
  readonly runResult: RunDebugInfo;
  readonly onLocate: (nodeId: string, name: string) => void;
}): JSX.Element {
  const { state } = useEditor();
  const nameOf = (nodeId: string): string => state.graph.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
  const rows = Object.entries(runResult.nodeStates).map(([nodeId, status]) => ({
    nodeId,
    name: nameOf(nodeId),
    status,
    output: runResult.nodeOutputs[nodeId],
  }));
  if (rows.length === 0) {
    return <span style={emptyStyle}>无节点状态</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto" }}>
      {rows.map((row) => {
        const meta = nodeStatusMeta(row.status);
        return (
          <div
            key={row.nodeId}
            role="button"
            tabIndex={0}
            title="点击直达节点"
            onClick={() => onLocate(row.nodeId, row.name)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onLocate(row.nodeId, row.name);
              }
            }}
            style={nodeRowStyle(row.status)}
          >
            <Badge color={meta.color} text={meta.label} />
            <span style={{ fontSize: 12, wordBreak: "break-all" }}>{row.name}</span>
            {row.output !== undefined && (
              <span
                style={{
                  marginLeft: "auto",
                  color: "#8c8c8c",
                  fontSize: 12,
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {summarizeValue(row.output, 40)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
