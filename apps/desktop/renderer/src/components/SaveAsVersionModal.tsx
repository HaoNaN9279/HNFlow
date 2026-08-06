// SaveAsVersionModal：模板引用子图「保存为新版本」（v0.4.1）。
// 上下文：只读子图层（editStack 非空 + readOnly true），栈顶 item 是模板引用节点，
// 当前 state.graph 是加载的模板子图（toEditorGraph 结果，含顶层元信息 id/name/version）。
// 发布：fromEditorGraph(state.graph, { id/name 沿用图元信息, version: 新版本 }) →
//       window.hnflow.releaseTemplate（主进程校验语义版本递增 + 中文错误翻译）。
// 成功：exitLevel 退出只读子层（popLevel 回父图 + 解除只读 + 清模板引用上下文），
//       提示父节点引用仍为旧版本（数据在 reducer levelGraphs 不可达，改引用走右键「升级版本」）。
// 防御：非模板引用子图层打开 → 提示并关闭。

import { useCallback, useEffect, useState } from "react";
import { Form, Input, message, Modal } from "antd";
import { fromEditorGraph } from "@core/editing/editor-graph";
import { useEditor } from "../editor/state.js";
import { useNodeUi } from "../editor/ui-context.js";
import { getCurrentTemplateRef, useEditStack } from "../hooks/useEditStack.js";

/** 语义版本 patch+1（如 1.1.0 → 1.1.1）；非法版本号返回空串（表单必填兜底）。 */
function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return "";
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** IPC/核心库错误 → message 文案（主进程已转中文友好消息，透传即可）。 */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 保存为新版本 Modal props：open 由 WorkflowToolbar 持有并传入。 */
interface SaveAsVersionModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function SaveAsVersionModal({ open, onClose }: SaveAsVersionModalProps) {
  const { state } = useEditor();
  const { readOnly } = useNodeUi();
  const { exitLevel } = useEditStack();
  const [newVersion, setNewVersion] = useState("");
  const [changelog, setChangelog] = useState("更新");
  const [releasing, setReleasing] = useState(false);

  // 打开时初始化（打开瞬间快照）：防御非模板引用子图层直接提示关闭；
  // 默认新版本 = 被引用版本 patch+1（state.graph.version 即模板子图版本），用户可改。
  useEffect(() => {
    if (!open) {
      return;
    }
    const templateRef = getCurrentTemplateRef();
    if (state.editStack.length === 0 || !readOnly || templateRef === undefined) {
      message.warning("当前不在模板引用子图层，无法保存为新版本。");
      onClose();
      return;
    }
    setNewVersion(bumpPatch(state.graph.version ?? ""));
    setChangelog("更新");
    setReleasing(false);
    // 依赖仅 open：取打开瞬间快照，打开期间状态变化不重置用户输入（同 UpgradeDialog 模式）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleRelease = useCallback(async () => {
    const templateRef = getCurrentTemplateRef();
    const top = state.editStack[state.editStack.length - 1];
    const version = newVersion.trim();
    if (templateRef === undefined || top === undefined || version === "") {
      return;
    }
    setReleasing(true);
    try {
      // 导出当前模板子图为 Workflow：id/name 沿用图元信息（模板内容元信息），version 用新版本号。
      const workflow = fromEditorGraph(state.graph, {
        id: state.graph.id ?? top.id,
        name: state.graph.name ?? top.name,
        version,
      });
      await window.hnflow.releaseTemplate({ name: templateRef.name, newVersion: version, changelog, workflow });
      // 发布成功：exitLevel 退出只读子层（popLevel 回父图 + 解除只读 + 清模板引用上下文）。
      exitLevel();
      message.success(
        `已保存为新版本 ${templateRef.name}@${version}；父节点引用仍为旧版本，请右键该节点「升级版本」更新引用。`,
      );
      onClose();
    } catch (error) {
      console.error("保存为新版本失败", error);
      message.error(errorText(error, "保存为新版本失败"));
    } finally {
      setReleasing(false);
    }
  }, [state, newVersion, changelog, exitLevel, onClose]);

  return (
    <Modal
      title="保存为新版本"
      open={open}
      onCancel={onClose}
      onOk={() => void handleRelease()}
      confirmLoading={releasing}
      okText="发布新版本"
      cancelText="取消"
      okButtonProps={{ disabled: newVersion.trim() === "" }}
      maskClosable={false}
      width={480}
    >
      <Form layout="vertical">
        <Form.Item label="新版本号（语义版本，需大于模板当前版本）" required>
          <Input value={newVersion} onChange={(e) => setNewVersion(e.target.value)} placeholder="如 1.1.1" />
        </Form.Item>
        <Form.Item label="更新说明">
          <Input.TextArea value={changelog} onChange={(e) => setChangelog(e.target.value)} rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
