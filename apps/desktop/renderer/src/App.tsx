// 应用根组件：AntD 中文环境 + 编辑器四区布局 + 全局状态 Provider。
// - EditorProvider：编辑状态（EditorState）容器（useEditor 消费）；
// - WorkflowGraphProvider：X6 图实例共享通道（T6/T7 经 useWorkflowGraphContext 取图）。
// - 工具栏：WorkflowToolbar（撤销/重做 T10 + 新建/打开/保存 T11 文件闭环）。
// - 物料区/配置区：T6 填充；画布区：WorkflowCanvas（T5）。

import { ConfigProvider, Layout } from "antd";
import zhCN from "antd/locale/zh_CN";
import { EditorProvider } from "./editor/state.js";
import { WorkflowGraphProvider } from "./editor/useWorkflowGraph.js";
import WorkflowCanvas from "./components/WorkflowCanvas.js";
import StencilPanel from "./components/StencilPanel.js";
import ConfigPanel from "./components/ConfigPanel.js";
import WorkflowToolbar from "./components/WorkflowToolbar.js";

const { Header, Sider, Content } = Layout;

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <EditorProvider>
        <WorkflowGraphProvider>
          <Layout className="app-layout">
            <Header id="toolbar" className="app-toolbar">
              <span className="app-logo">HNFlow</span>
              <span className="app-subtitle">工作流编辑器 v0.4.0</span>
              <span className="app-toolbar-spacer" />
              <WorkflowToolbar />
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
        </WorkflowGraphProvider>
      </EditorProvider>
    </ConfigProvider>
  );
}
