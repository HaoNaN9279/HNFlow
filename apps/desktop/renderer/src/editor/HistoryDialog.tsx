// HistoryDialog：模板版本历史查看（v0.4.1）。
// - 打开：右键菜单「查看历史」→ useNodeUi().historyTarget 携带 subworkflow 节点；
// - 加载：解析 params.template 模板名 → listTemplates 定位 → 左侧版本列表（版本号/时间/变更说明，
//   currentVersion 标「当前」）；点选版本 → loadTemplateVersion 拉取内容 → 右侧预览
//   （节点数 / 边数 / 节点名列表）。

import { useEffect, useState } from "react";
import { Col, Descriptions, List, Modal, Row, Spin, Tag, Typography, message } from "antd";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { TemplateSummary } from "../../../src/shared/ipc.js";

/** 解析 "name@version" 模板引用：非法（缺失/空段）返回 undefined。 */
function parseTemplateRef(ref: unknown): { readonly name: string; readonly version: string } | undefined {
  if (typeof ref !== "string") {
    return undefined;
  }
  const sep = ref.lastIndexOf("@");
  if (sep <= 0 || sep === ref.length - 1) {
    return undefined;
  }
  return { name: ref.slice(0, sep), version: ref.slice(sep + 1) };
}

/** IPC 未知节点数据安全读 name：非对象/非字符串回退「（未命名）」。 */
function nodeNameOf(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "name" in raw) {
    const name = raw.name;
    return typeof name === "string" ? name : "（未命名）";
  }
  return "（未命名）";
}

/** IPC/核心库错误 → message 文案（主进程已转中文友好消息，透传即可）。 */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 版本内容预览。 */
interface VersionPreview {
  readonly nodeNames: readonly string[];
  readonly edgeCount: number;
}

/** 历史查看 props：target 由 NodeUiProvider 注入（historyTarget 变化即打开）。 */
interface HistoryDialogProps {
  readonly target: EditorGraphNode | undefined;
  readonly onClose: () => void;
}

export function HistoryDialog({ target, onClose }: HistoryDialogProps) {
  const [summary, setSummary] = useState<TemplateSummary | undefined>(undefined);
  const [selectedVersion, setSelectedVersion] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<VersionPreview | undefined>(undefined);

  // 打开时加载模板摘要：解析 name → listTemplates → 默认选中 currentVersion。
  useEffect(() => {
    const node = target;
    if (node === undefined) {
      return; // 关闭态：Modal 隐藏不渲染内容，下次打开重新加载
    }
    let cancelled = false;
    setSummary(undefined);
    setSelectedVersion(undefined);
    setPreview(undefined);
    void (async () => {
      try {
        const ref = parseTemplateRef(node.params["template"]);
        if (ref === undefined) {
          message.error("节点未锁定模板版本（params.template 缺失或格式非法）。");
          onClose();
          return;
        }
        const templates = await window.hnflow.listTemplates();
        const found = templates.find((t) => t.name === ref.name);
        if (found === undefined) {
          message.error(`模板 "${ref.name}" 不存在。`);
          onClose();
          return;
        }
        if (!cancelled) {
          setSummary(found);
          setSelectedVersion(found.currentVersion);
        }
      } catch (error) {
        console.error("加载模板历史失败", error);
        if (!cancelled) {
          message.error(errorText(error, "加载模板历史失败"));
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, onClose]);

  // 选中版本变化：loadTemplateVersion 拉取内容预览。
  useEffect(() => {
    const name = summary?.name;
    const version = selectedVersion;
    if (name === undefined || version === undefined) {
      return;
    }
    let cancelled = false;
    setPreview(undefined);
    void (async () => {
      try {
        const result = await window.hnflow.loadTemplateVersion({ name, version });
        if (!cancelled) {
          setPreview({
            nodeNames: result.workflow.nodes.map(nodeNameOf),
            edgeCount: result.workflow.edges.length,
          });
        }
      } catch (error) {
        console.error("加载版本预览失败", error);
        if (!cancelled) {
          message.error(errorText(error, "加载版本预览失败"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [summary?.name, selectedVersion]);

  const open = target !== undefined;
  return (
    <Modal
      title={summary === undefined ? "模板版本历史" : `模板版本历史：${summary.name}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
    >
      {summary === undefined ? (
        <div style={{ textAlign: "center", padding: 32 }}>
          <Spin />
        </div>
      ) : (
        <Row gutter={16}>
          <Col span={10}>
            <Typography.Text strong>版本列表</Typography.Text>
            <List
              size="small"
              dataSource={[...summary.versions].reverse()}
              renderItem={(item) => (
                <List.Item
                  onClick={() => setSelectedVersion(item.version)}
                  style={{
                    cursor: "pointer",
                    background: item.version === selectedVersion ? "#e6f4ff" : undefined,
                  }}
                >
                  <List.Item.Meta
                    title={
                      <span>
                        {item.version}
                        {item.version === summary.currentVersion && (
                          <Tag color="blue" style={{ marginLeft: 8 }}>
                            当前
                          </Tag>
                        )}
                      </span>
                    }
                    description={
                      <div>
                        <div>{new Date(item.createdAt).toLocaleDateString("zh-CN")}</div>
                        <div style={{ color: "#8c8c8c" }}>{item.changelog}</div>
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
          </Col>
          <Col span={14}>
            <Typography.Text strong>版本内容</Typography.Text>
            {preview === undefined ? (
              <div style={{ textAlign: "center", padding: 32 }}>
                <Spin />
              </div>
            ) : (
              <>
                <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                  <Descriptions.Item label="节点数">{preview.nodeNames.length}</Descriptions.Item>
                  <Descriptions.Item label="边数">{preview.edgeCount}</Descriptions.Item>
                </Descriptions>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {preview.nodeNames.map((name, index) => (
                    <Tag key={`${name}-${index}`}>{name}</Tag>
                  ))}
                </div>
              </>
            )}
          </Col>
        </Row>
      )}
    </Modal>
  );
}
