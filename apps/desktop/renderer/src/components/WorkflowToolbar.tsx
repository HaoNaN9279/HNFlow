// WorkflowToolbar：工具栏动作（撤销/重做 + 新建/打开/保存）。
// - 撤销/重做：T10 接入 workflowUndo/workflowRedo（X6 History 插件）；
// - 新建/打开/保存：T11 接入 useWorkflowFile（window.hnflow 文件闭环，经 IPC 走核心库校验）。

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

export default function WorkflowToolbar() {
  const { handleNew, handleOpen, handleSave } = useWorkflowFile();

  return (
    <>
      <Button icon={<UndoOutlined />} onClick={workflowUndo}>
        撤销
      </Button>
      <Button icon={<RedoOutlined />} onClick={workflowRedo}>
        重做
      </Button>
      <Button icon={<FileAddOutlined />} onClick={() => void handleNew()}>
        新建
      </Button>
      <Button icon={<FolderOpenOutlined />} onClick={() => void handleOpen()}>
        打开
      </Button>
      <Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSave()}>
        保存
      </Button>
    </>
  );
}
