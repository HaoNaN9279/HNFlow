// 应用根组件：AntD 中文环境 + 编辑器四区布局 + 全局状态 Provider。
// - EditorProvider：编辑状态（EditorState）容器（useEditor 消费）；
// - WorkflowGraphProvider：X6 图实例共享通道（T6/T7 经 useWorkflowGraphContext 取图）；
// - NodeUiProvider：共享 UI 上下文（右键菜单目标/全局只读/升级与历史对话框，v0.4.1）。
// - 工具栏：WorkflowToolbar（撤销/重做 T10 + 新建/打开/保存 T11 文件闭环）。
// - 物料区/配置区：T6 填充；画布区：WorkflowCanvas（T5）。

import { useEffect, useState } from "react";
import { ConfigProvider, Layout } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReviewRequestInfo } from "../../src/shared/ipc.js";
import { EditorProvider } from "./editor/state.js";
import { WorkflowGraphProvider } from "./editor/useWorkflowGraph.js";
import { NodeUiProvider } from "./editor/ui-context.js";
import WorkflowCanvas from "./components/WorkflowCanvas.js";
import StencilPanel from "./components/StencilPanel.js";
import ConfigPanel from "./components/ConfigPanel.js";
import WorkflowToolbar from "./components/WorkflowToolbar.js";
import AgentChatPanel from "./components/AgentChatPanel.js";
import { ReviewDialog } from "./components/ReviewDialog.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { ErrorPanel } from "./components/ErrorPanel.js";
import { DebugPanel } from "./components/DebugPanel.js";

const { Header, Sider, Content } = Layout;

export default function App() {
  const [agentOpen, setAgentOpen] = useState(false);
  const [reviewRequest, setReviewRequest] = useState<ReviewRequestInfo | null>(null);
  // 订阅审核请求：main 运行到待审核 command 节点时弹对话框（onReviewRequest 返回取消函数，随卸载清理）。
  useEffect(() => window.hnflow.onReviewRequest(setReviewRequest), []);
  // 提交决策：先关框防重复点击，再经 IPC 告知 main（main 侧 resolve 对应 pending 请求后继续执行）。
  const submitReview = (decision: "approve" | "reject") => {
    if (reviewRequest === null) {
      return;
    }
    const request = reviewRequest;
    setReviewRequest(null);
    void window.hnflow.sendReviewDecision({ requestId: request.requestId, decision }).catch((error: unknown) => {
      console.error("提交审核决策失败", error);
    });
  };
  return (
    <ConfigProvider locale={zhCN}>
      <EditorProvider>
        <WorkflowGraphProvider>
          <NodeUiProvider>
            <Layout className="app-layout">
              <Header id="toolbar" className="app-toolbar">
                <span className="app-logo">HNFlow</span>
                <span className="app-subtitle">工作流编辑器 v0.4.0</span>
                <span className="app-toolbar-spacer" />
                <WorkflowToolbar onToggleAgent={() => setAgentOpen((v) => !v)} />
              </Header>
              <Layout>
                <Sider id="stencil-panel" width={240} className="app-panel">
                  <StencilPanel />
                </Sider>
                <Content id="canvas" className="app-canvas">
                  <WorkflowCanvas />
                </Content>
                <Sider id="config-panel" width={280} className="app-panel" theme="light">
                  <ConfigPanel />
                </Sider>
              </Layout>
            </Layout>
            <AgentChatPanel open={agentOpen} onClose={() => setAgentOpen(false)} />
            <ReviewDialog
              request={reviewRequest}
              onApprove={() => submitReview("approve")}
              onReject={() => submitReview("reject")}
            />
            <NodeContextMenu />
            <ErrorPanel />
            <DebugPanel />
          </NodeUiProvider>
        </WorkflowGraphProvider>
      </EditorProvider>
    </ConfigProvider>
  );
}
