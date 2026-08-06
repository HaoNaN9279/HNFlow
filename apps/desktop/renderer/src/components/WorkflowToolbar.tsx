// WorkflowToolbar：工具栏动作（撤销/重做 + 新建/打开/保存）。
// - 撤销/重做：T10 接入 workflowUndo/workflowRedo（X6 History 插件）；
// - 新建/打开/保存：T11 接入 useWorkflowFile（window.hnflow 文件闭环，经 IPC 走核心库校验）；
// - v0.4.1：只读模式（模板引用子图）→ 撤销/重做禁用；保存按钮切换为「保存为新版本」
//   打开 SaveAsVersionModal（发布到模板库后退出只读子层）。
// - v0.4.1 修复：只读子图层点「新建/打开」会 dispatch setGraph 清空 editStack，但
//   NodeUiContext 的 readOnly 不会自动重置；故先在 onClick 里 setReadOnly(false)
//   再执行 handleNew/handleOpen，避免整画布残留只读模式。

import { useState } from "react";
import { Button } from "antd";
import {
  FileAddOutlined,
  FolderOpenOutlined,
  RedoOutlined,
  SaveOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { workflowRedo, workflowUndo } from "./WorkflowCanvas.js";
import { useWorkflowFile } from "../hooks/useWorkflowFile.js";
import { useNodeUi } from "../editor/ui-context.js";
import { SaveAsVersionModal } from "./SaveAsVersionModal.js";

export default function WorkflowToolbar() {
  const { handleNew, handleOpen, handleSave } = useWorkflowFile();
  const { readOnly, setReadOnly } = useNodeUi();
  const [saveAsVersionOpen, setSaveAsVersionOpen] = useState(false);

  return (
    <>
      <Button
        icon={<UndoOutlined />}
        disabled={readOnly}
        onClick={() => {
          if (readOnly) return;
          workflowUndo();
        }}
      >
        撤销
      </Button>
      <Button
        icon={<RedoOutlined />}
        disabled={readOnly}
        onClick={() => {
          if (readOnly) return;
          workflowRedo();
        }}
      >
        重做
      </Button>
      <Button
        icon={<FileAddOutlined />}
        onClick={() => {
          setReadOnly(false);
          void handleNew();
        }}
      >
        新建
      </Button>
      <Button
        icon={<FolderOpenOutlined />}
        onClick={() => {
          setReadOnly(false);
          void handleOpen();
        }}
      >
        打开
      </Button>
      {readOnly ? (
        <Button type="primary" icon={<SaveOutlined />} onClick={() => setSaveAsVersionOpen(true)}>
          保存为新版本
        </Button>
      ) : (
        <Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSave()}>
          保存
        </Button>
      )}
      <SaveAsVersionModal open={saveAsVersionOpen} onClose={() => setSaveAsVersionOpen(false)} />
    </>
  );
}
