// DebugPanel：调试面板（T3）——最近一次运行（RunDebugInfo）三 tab 展示（执行日志/变量/节点状态）。
// - 数据源 useEditor().state.runResult（useWorkflowFile.handleRun 写入；运行开始/失败清 null）；
// - 无 runResult 时隐藏；本地折叠/关闭（新 runResult 到来时重置为展开显示）；
// - 样式：absolute 画布底部右侧浮层（zIndex 40，同 ErrorPanel 惯例），内联样式（不碰 global.css）；
// - 三 tab 子组件见 DebugPanelTabs.tsx（同目录拆分，保持本文件 ≤250 行）；
// - 节点状态行点击直达：浅层定位（当前层图 centerCell + select，同 useErrorNavigation 定位逻辑——
//   navigateToError 依赖 runError 不接受 nodeId 参数，故本面板自行定位）；
// - 日志定位：浅层提取 message 内 `node:<id>` 可点击直达（复用 locateNode 浅层定位）。

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Badge, Button, Tabs, Typography, message } from "antd";
import { CloseOutlined, DownOutlined, UpOutlined } from "@ant-design/icons";
import type { LogLevelFilter } from "../debug/format.js";
import { editorActions, useEditor } from "../editor/state.js";
import { useWorkflowGraphContext } from "../editor/useWorkflowGraph.js";
import { LogsTab, NodesTab, VarsTab } from "./DebugPanelTabs.js";
import { AnalysisPanel } from "./AnalysisPanel.js";

const panelStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  right: 16,
  zIndex: 40,
  width: 420,
  maxWidth: "calc(100% - 32px)",
  display: "flex",
  flexDirection: "column",
  background: "#fff",
  border: "1px solid #d9d9d9",
  borderRadius: 8,
  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
};
const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderBottom: "1px solid #f0f0f0",
};
const metaStyle: CSSProperties = { color: "#8c8c8c", fontSize: 12 };

export function DebugPanel(): JSX.Element | null {
  const { state, dispatch } = useEditor();
  const graphRef = useWorkflowGraphContext();
  const runResult = state.runResult;
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [logLevel, setLogLevel] = useState<LogLevelFilter>("all");

  // 新运行结果到来时重置本地 UI 状态：展开 + 恢复显示（每次运行生成新 RunDebugInfo 对象）。
  useEffect(() => {
    setCollapsed(false);
    setDismissed(false);
  }, [runResult]);

  /** 浅层定位：当前层图 centerCell + select（navigateToError 只认 runError，不能复用，故自行实现）。 */
  const locateNode = useCallback(
    (nodeId: string, name: string): void => {
      const graph = graphRef.current;
      if (graph === null) {
        return;
      }
      const cell = graph.getCellById(nodeId);
      if (cell === undefined) {
        message.warning(`节点「${name}」不在当前画布中`);
        return;
      }
      graph.centerCell(cell);
      if (graph.zoom() < 0.5) {
        graph.zoomToFit({ padding: 100, maxScale: 1.2 });
      }
      graph.select(cell);
      dispatch(editorActions.selectNode(nodeId));
    },
    [graphRef, dispatch],
  );

  if (runResult === null || dismissed) {
    return null;
  }
  const hasFailed = Object.values(runResult.nodeStates).some((status) => status === "Failed");
  const durationMs = Math.max(0, runResult.endTime - runResult.startTime);
  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <Typography.Text strong>调试面板</Typography.Text>
        <span style={metaStyle}>runId: {runResult.runId}</span>
        <span style={metaStyle}>{durationMs} ms</span>
        <Badge color={hasFailed ? "error" : "success"} text={hasFailed ? "运行失败" : "运行成功"} />
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          type="text"
          icon={collapsed ? <UpOutlined /> : <DownOutlined />}
          aria-label={collapsed ? "展开调试面板" : "折叠调试面板"}
          onClick={() => setCollapsed((value) => !value)}
        />
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          aria-label="关闭调试面板"
          onClick={() => setDismissed(true)}
        />
      </div>
      {!collapsed && (
        <div style={{ padding: "0 10px 10px" }}>
          <Tabs
            size="small"
            items={[
              {
                key: "logs",
                label: "执行日志",
                children: (
                  <LogsTab
                    logs={runResult.logs}
                    level={logLevel}
                    onLevelChange={setLogLevel}
                    onLocate={(nodeId) => locateNode(nodeId, nodeId)}
                  />
                ),
              },
              { key: "vars", label: "变量", children: <VarsTab snapshot={runResult.contextSnapshot} /> },
              { key: "nodes", label: "节点状态", children: <NodesTab runResult={runResult} onLocate={locateNode} /> },
              { key: "analysis", label: "分析", children: <AnalysisPanel debug={runResult} /> },
            ]}
          />
        </div>
      )}
    </div>
  );
}
