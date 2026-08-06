// AgentChatPanel：右侧 AI 对话抽屉（v0.4.2 验收 1）。
// - 消息列表 + 输入框 → window.hnflow.chatWithAgent（main 进程 AIExecutor + generate_workflow 工具）；
// - 返回带 workflow → 显示「应用为新建工作流」→ useWorkflowFile.applyGeneratedWorkflow 载入新画布；
// - 模型配置折叠区（provider/model/apiKey/baseURL）经 localStorage 持久化（hnflow.agent.model）。
// 样式：内联 CSSProperties（不碰 global.css），消息气泡仿常见聊天界面。

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, Collapse, Drawer, Input, Select, Space, Typography } from "antd";
import { RobotOutlined, SendOutlined } from "@ant-design/icons";
import type { Workflow } from "@core/model/types";
import type { AgentChatMessage, AgentChatModelConfig, AgentChatResult } from "../../../src/shared/ipc.js";
import { useWorkflowFile } from "../hooks/useWorkflowFile.js";

/** 模型配置持久化键。 */
const STORAGE_KEY = "hnflow.agent.model";

/** 持久化模型配置（面板表单状态镜像）。 */
interface PersistedModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseURL: string;
}

/** 缺省配置：fake 为默认 provider（内置脚本，无需密钥）。 */
const FALLBACK_CONFIG: PersistedModelConfig = { provider: "fake", model: "", apiKey: "", baseURL: "" };

/** 读取持久化配置：JSON 损坏/缺字段时回退默认（不跨出 unknown，零类型断言）。 */
function readPersistedConfig(): PersistedModelConfig {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return FALLBACK_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return FALLBACK_CONFIG;
  }
  if (typeof parsed !== "object" || parsed === null) return FALLBACK_CONFIG;
  const provider = "provider" in parsed && typeof parsed.provider === "string" ? parsed.provider : "fake";
  const model = "model" in parsed && typeof parsed.model === "string" ? parsed.model : "";
  const apiKey = "apiKey" in parsed && typeof parsed.apiKey === "string" ? parsed.apiKey : "";
  const baseURL = "baseURL" in parsed && typeof parsed.baseURL === "string" ? parsed.baseURL : "";
  return { provider, model, apiKey, baseURL };
}

/** 消息行：用户右对齐、AI 左对齐。 */
const bubbleRowStyle = (role: AgentChatMessage["role"]): CSSProperties => ({
  display: "flex",
  justifyContent: role === "user" ? "flex-end" : "flex-start",
  marginBottom: 8,
});

/** 气泡：用户蓝底白字、AI 白底灰字。 */
const bubbleStyle = (role: AgentChatMessage["role"]): CSSProperties => ({
  maxWidth: "85%",
  padding: "8px 12px",
  borderRadius: 8,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: role === "user" ? "#1677ff" : "#ffffff",
  color: role === "user" ? "#ffffff" : "rgba(0, 0, 0, 0.88)",
  border: role === "user" ? "none" : "1px solid #d9d9d9",
});

interface AgentChatPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function AgentChatPanel({ open, onClose }: AgentChatPanelProps): JSX.Element {
  const { applyGeneratedWorkflow } = useWorkflowFile();
  const [provider, setProvider] = useState("fake");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [messages, setMessages] = useState<readonly AgentChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [appliable, setAppliable] = useState<{ readonly workflow: unknown; readonly summary: string } | null>(null);

  // 挂载时读取持久化模型配置（一次）。
  useEffect(() => {
    const saved = readPersistedConfig();
    setProvider(saved.provider);
    setModelName(saved.model);
    setApiKey(saved.apiKey);
    setBaseURL(saved.baseURL);
  }, []);

  // 配置变更即写回 localStorage。
  useEffect(() => {
    const value: PersistedModelConfig = { provider, model: modelName, apiKey, baseURL };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }, [provider, modelName, apiKey, baseURL]);

  /** 当前模型配置：fake 不带密钥字段；openai 仅传非空项。 */
  const modelConfig = useMemo<AgentChatModelConfig>(() => {
    const isOpenai = provider === "openai";
    return {
      provider,
      ...(isOpenai && modelName.trim() !== "" ? { model: modelName.trim() } : {}),
      ...(isOpenai && apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
      ...(isOpenai && baseURL.trim() !== "" ? { baseURL: baseURL.trim() } : {}),
    };
  }, [provider, modelName, apiKey, baseURL]);

  /** 发送：追加用户消息 → chatWithAgent → 追加 AI 回复；带 workflow 时标记可应用。 */
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (text === "" || loading) return;
    const userMessage: AgentChatMessage = { role: "user", content: text };
    const history: readonly AgentChatMessage[] = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setLoading(true);
    setAppliable(null);
    try {
      const result: AgentChatResult = await window.hnflow.chatWithAgent({ messages: history, model: modelConfig });
      if (!result.ok) {
        setMessages([...history, { role: "assistant", content: result.message }]);
        return;
      }
      setMessages([...history, { role: "assistant", content: result.reply }]);
      if (result.workflow !== undefined) {
        setAppliable({ workflow: result.workflow, summary: result.summary ?? "" });
      }
    } catch (error) {
      const detail = error instanceof Error && error.message !== "" ? error.message : "AI 对话失败";
      setMessages([...history, { role: "assistant", content: detail }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, modelConfig]);

  /** 应用生成工作流为新画布（复用 useWorkflowFile 载入路径）。 */
  const handleApply = useCallback(async () => {
    if (appliable === null) return;
    await applyGeneratedWorkflow(appliable.workflow as Workflow);
    setAppliable(null);
  }, [appliable, applyGeneratedWorkflow]);

  return (
    <Drawer
      title={
        <Space>
          <RobotOutlined />
          AI 助手
        </Space>
      }
      placement="right"
      width={380}
      open={open}
      onClose={onClose}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
        <Collapse
          size="small"
          items={[
            {
              key: "model",
              label: "模型配置",
              children: (
                <Space direction="vertical" style={{ width: "100%" }} size={4}>
                  <Select
                    value={provider}
                    onChange={setProvider}
                    options={[
                      { value: "fake", label: "fake（内置脚本）" },
                      { value: "openai", label: "openai" },
                    ]}
                  />
                  {provider === "openai" && (
                    <>
                      <Input placeholder="模型名（默认 gpt-4o）" value={modelName} onChange={(e) => setModelName(e.target.value)} />
                      <Input.Password placeholder="API Key（缺省用环境变量）" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                      <Input placeholder="Base URL（可选）" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
                    </>
                  )}
                  {provider === "fake" && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      fake 使用内置固定脚本，无需密钥（测试/演示）。
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
          ]}
        />
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {messages.length === 0 && !loading && (
            <Typography.Text type="secondary" style={{ margin: "auto", fontSize: 13 }}>
              输入自然语言生成工作流，例如：创建一个发布流程，包含资源导入、打包、测试
            </Typography.Text>
          )}
          {messages.map((message, index) => (
            <div key={index} style={bubbleRowStyle(message.role)}>
              <div style={bubbleStyle(message.role)}>{message.content}</div>
            </div>
          ))}
          {loading && (
            <div style={bubbleRowStyle("assistant")}>
              <div style={bubbleStyle("assistant")}>生成中…</div>
            </div>
          )}
        </div>
        {appliable !== null && (
          <Button type="primary" block icon={<RobotOutlined />} onClick={() => void handleApply()}>
            {appliable.summary === "" ? "应用为新建工作流" : `应用为新建工作流：${appliable.summary}`}
          </Button>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => void handleSend()}
            placeholder="描述你想生成的工作流…"
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={loading}
            disabled={input.trim() === ""}
            onClick={() => void handleSend()}
          >
            发送
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
