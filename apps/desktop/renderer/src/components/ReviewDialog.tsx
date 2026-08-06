// 命令审核对话框（v0.4.2 验收 2）：运行到待审核 command 节点时由 App.tsx 挂起展示。
// - 展示待审核命令节点信息（nodeId + description）+ 批准执行 / 拒绝跳过；
// - 关闭（X / Esc / 遮罩不可点）视为拒绝：走 onReject，引擎收到 reject 不挂死；
// - 纯受控组件：不持内部状态，请求与决策回调由父级注入。

import { Modal } from "antd";
import type { ReviewRequestInfo } from "../../../src/shared/ipc.js";

interface ReviewDialogProps {
  /** 当前待审核请求；null = 无请求（对话框隐藏）。 */
  readonly request: ReviewRequestInfo | null;
  /** 批准执行：提交 "approve" 决策。 */
  readonly onApprove: () => void;
  /** 拒绝跳过（含关闭对话框）：提交 "reject" 决策。 */
  readonly onReject: () => void;
}

/** 命令审核模态框：请求存在时展示，OK=批准执行，取消/关闭=拒绝跳过。 */
export function ReviewDialog({ request, onApprove, onReject }: ReviewDialogProps): JSX.Element {
  return (
    <Modal
      open={request !== null}
      title="命令待人工审核"
      okText="批准执行"
      cancelText="拒绝跳过"
      onOk={onApprove}
      onCancel={onReject}
      maskClosable={false}
      width={460}
    >
      {request !== null && (
        <div>
          <p style={{ marginTop: 0 }}>
            AI 生成的命令需要人工确认后方可执行。拒绝后该节点将标记为失败并跳过。
          </p>
          <p style={{ margin: "8px 0" }}>
            <strong>节点：</strong>
            {request.nodeId}
          </p>
          <p style={{ margin: "8px 0", wordBreak: "break-all" }}>
            <strong>命令：</strong>
            {request.description}
          </p>
        </div>
      )}
    </Modal>
  );
}
