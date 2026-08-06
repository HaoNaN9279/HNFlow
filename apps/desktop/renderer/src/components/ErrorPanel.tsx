// ErrorPanel：运行失败信息展示 + 点击直达导航（v0.4.2 验收 5）。
// - 数据源 useEditor().state.runError（useWorkflowFile.handleRun 写入；开始运行/运行成功清 null）；
// - 无 runError 时隐藏；关闭按钮 dispatch setRunError(null)；
// - 展示：错误 message + nodePath 面包屑（「顶层工作流 > 发布子流程 > 资源导入」，
//   整条路径可点击直达失败节点）；nodePath 缺失时仅展示 message + nodeId；
// - 直达：useErrorNavigation.navigateToError（逐层进入子工作流 → centerCell + select 高亮叶子）。
// - 样式：absolute 画布底部居中浮层（zIndex 40，高于 MiniMap z20 / 只读条 z10），
//   内联样式（不碰 global.css，同 CanvasToolsOverlay 惯例）。

import type { CSSProperties } from "react";
import { Button } from "antd";
import { CloseOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { editorActions, useEditor } from "../editor/state.js";
import { parseNodePath } from "../editor/error-nav.js";
import { useErrorNavigation } from "../hooks/useErrorNavigation.js";

/** 面板容器：画布底部居中，pointer-events 自身交互（不拦截画布其余区域）。 */
const panelStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 40,
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: "70%",
  padding: "10px 14px",
  borderRadius: 8,
  background: "#fff2f0",
  border: "1px solid #ffccc7",
  boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
};

/** 文本区容器：垂直排列消息与路径，minWidth 0 配合父级 maxWidth 防溢出。 */
const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
};

/** 面包屑按钮：无边框链接样式，整条路径可点击直达。 */
const crumbStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexWrap: "wrap",
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "#1677ff",
  fontSize: 12,
  textAlign: "left",
  font: "inherit",
};

/** 段间分隔符样式。 */
const separatorStyle: CSSProperties = { margin: "0 4px", color: "#8c8c8c" };

export function ErrorPanel(): JSX.Element | null {
  const { state, dispatch } = useEditor();
  const { navigateToError } = useErrorNavigation();
  const error = state.runError;
  if (error === null) {
    return null;
  }
  const pathSegments = error.nodePath === undefined ? [] : parseNodePath(error.nodePath);
  const canNavigate = pathSegments.length > 0 || error.nodeId !== undefined;
  return (
    <div style={panelStyle} role="alert">
      <ThunderboltOutlined style={{ color: "#ff4d4f" }} />
      <div style={bodyStyle}>
        <span style={{ color: "#cf1322", fontSize: 13, wordBreak: "break-all" }}>{error.message}</span>
        {pathSegments.length > 0 ? (
          <button type="button" title="点击直达失败节点" onClick={navigateToError} style={crumbStyle}>
            {pathSegments.map((segment, index) => (
              <span key={`${index}-${segment}`}>
                {index > 0 && <span style={separatorStyle}>›</span>}
                <span>{segment}</span>
              </span>
            ))}
          </button>
        ) : error.nodeId !== undefined ? (
          <span style={{ color: "#8c8c8c", fontSize: 12, wordBreak: "break-all" }}>节点：{error.nodeId}</span>
        ) : null}
      </div>
      <Button size="small" type="primary" disabled={!canNavigate} onClick={navigateToError}>
        直达
      </Button>
      <Button
        size="small"
        type="text"
        icon={<CloseOutlined />}
        aria-label="关闭错误面板"
        onClick={() => dispatch(editorActions.setRunError(null))}
      />
    </div>
  );
}
