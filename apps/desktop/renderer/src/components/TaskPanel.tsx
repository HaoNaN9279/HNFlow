// TaskPanel：人工任务面板（v0.9.3）。
// - 数据源 window.hnflow.listTasks()；挂载时初始化 + 订阅 onTaskCreated（新任务自动刷新 + 提示）；
// - 待处理区（pending）：提交结果（textarea + submitTask）/ 跳过（skipTask）；
// - 已完成区（completed）：结果摘要 + 打回（reopenTask → 回 pending）；
// - 操作成功刷新列表；TaskActionResult.ok=false 展示中文错误消息；
// - 样式：absolute 画布右下角浮层（同 DebugPanel 惯例），内联样式，不碰 global.css。

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Button, Input, Typography, message } from "antd";
import { CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import type { TaskActionResult, TaskSummary } from "../../../src/shared/ipc.js";
import { formatTaskResult, formatTaskTime, splitTasks } from "../hooks/task-panel.js";

const panelStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  right: 16,
  zIndex: 40,
  width: 420,
  maxWidth: "calc(100% - 32px)",
  maxHeight: "calc(100% - 32px)",
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
const bodyStyle: CSSProperties = { padding: 10, overflowY: "auto" };
const sectionStyle: CSSProperties = { margin: "4px 0 6px", color: "#595959", fontSize: 13, fontWeight: 600 };
const cardStyle: CSSProperties = {
  padding: "8px 10px",
  marginBottom: 8,
  borderRadius: 6,
  border: "1px solid #f0f0f0",
  background: "#fafafa",
};
const cardHeaderStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const metaStyle: CSSProperties = { color: "#8c8c8c", fontSize: 12 };
const descStyle: CSSProperties = { margin: "4px 0", color: "#595959", fontSize: 12, wordBreak: "break-all" };
const emptyStyle: CSSProperties = { padding: "12px 0", textAlign: "center", color: "#bfbfbf", fontSize: 13 };

interface TaskPanelProps {
  /** 关闭面板（App 卸载组件，卸载即清理 onTaskCreated 订阅）。 */
  readonly onClose: () => void;
}

/** 人工任务面板：待处理（提交/跳过）与已完成（打回）两区，任务创建事件自动刷新。 */
export function TaskPanel({ onClose }: TaskPanelProps): JSX.Element {
  const [tasks, setTasks] = useState<readonly TaskSummary[] | undefined>(undefined);
  /** 各待处理任务的输入草稿（key=taskId；提交后保留，打回回来可继续编辑）。 */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  /** 正在执行操作的任务 id（防重复点击）。 */
  const [busy, setBusy] = useState<string | null>(null);

  /** 拉取任务列表（挂载初始化与操作成功后复用）。 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.hnflow.listTasks();
      setTasks(list);
    } catch (error: unknown) {
      console.error("人工任务列表加载失败", error);
      message.error("任务列表加载失败");
    }
  }, []);

  // 挂载时初始化 + 订阅任务创建事件（新任务自动刷新 + 提示）；卸载时清理订阅。
  useEffect(() => {
    void refresh();
    return window.hnflow.onTaskCreated(() => {
      void refresh();
      message.info("有新人工任务待处理");
    });
  }, [refresh]);

  /** 通用操作：防重复 → IPC → 成功刷新 / 失败展示中文消息。 */
  const runAction = useCallback(
    async (taskId: string, action: () => Promise<TaskActionResult>): Promise<void> => {
      if (busy !== null) {
        return;
      }
      setBusy(taskId);
      try {
        const result = await action();
        if (result.ok) {
          message.success("操作成功");
          await refresh();
        } else {
          message.error(result.message);
        }
      } catch (error: unknown) {
        console.error("人工任务操作失败", error);
        message.error("操作失败，请重试");
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  const handleSubmit = (task: TaskSummary): void => {
    const result = drafts[task.id] ?? "";
    if (result.trim() === "") {
      message.warning("请输入提交结果");
      return;
    }
    void runAction(task.id, () => window.hnflow.submitTask({ taskId: task.id, result }));
  };

  const handleSkip = (task: TaskSummary): void => {
    void runAction(task.id, () => window.hnflow.skipTask({ taskId: task.id }));
  };

  const handleReopen = (task: TaskSummary): void => {
    void runAction(task.id, () => window.hnflow.reopenTask({ taskId: task.id }));
  };

  /** 待处理任务卡片：标题/节点/创建时间/描述 + 结果输入 + 提交/跳过。 */
  const renderPendingCard = (task: TaskSummary): JSX.Element => {
    const current = busy === task.id;
    return (
      <div key={task.id} style={cardStyle}>
        <div style={cardHeaderStyle}>
          <Typography.Text strong>{task.title}</Typography.Text>
          <span style={metaStyle}>{task.nodeName}</span>
          <span style={{ flex: 1 }} />
          <Button size="small" disabled={busy !== null} onClick={() => handleSkip(task)}>
            跳过
          </Button>
        </div>
        <div style={metaStyle}>创建：{formatTaskTime(task.createdAt)}</div>
        {task.description !== undefined && <div style={descStyle}>{task.description}</div>}
        <Input.TextArea
          rows={2}
          placeholder="输入人工处理结果…"
          value={drafts[task.id] ?? ""}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))}
        />
        <div style={{ marginTop: 6, textAlign: "right" }}>
          <Button
            type="primary"
            size="small"
            loading={current}
            disabled={busy !== null && !current}
            onClick={() => handleSubmit(task)}
          >
            提交结果
          </Button>
        </div>
      </div>
    );
  };

  /** 已完成任务卡片：标题/节点/完成时间/结果摘要 + 打回。 */
  const renderCompletedCard = (task: TaskSummary): JSX.Element => {
    const current = busy === task.id;
    return (
      <div key={task.id} style={cardStyle}>
        <div style={cardHeaderStyle}>
          <Typography.Text strong>{task.title}</Typography.Text>
          <span style={metaStyle}>{task.nodeName}</span>
          <span style={{ flex: 1 }} />
          <Button
            size="small"
            loading={current}
            disabled={busy !== null && !current}
            onClick={() => handleReopen(task)}
          >
            打回
          </Button>
        </div>
        <div style={metaStyle}>完成：{task.completedAt === undefined ? "—" : formatTaskTime(task.completedAt)}</div>
        <div style={descStyle}>结果：{formatTaskResult(task.result)}</div>
      </div>
    );
  };

  const { pending, completed } = splitTasks(tasks ?? []);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <Typography.Text strong>人工任务</Typography.Text>
        <span style={metaStyle}>{tasks === undefined ? "加载中…" : `${pending.length} 待处理`}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          aria-label="刷新任务列表"
          onClick={() => void refresh()}
        />
        <Button size="small" type="text" icon={<CloseOutlined />} aria-label="关闭人工任务面板" onClick={onClose} />
      </div>
      <div style={bodyStyle}>
        {tasks === undefined ? (
          <div style={emptyStyle}>加载中…</div>
        ) : (
          <>
            <div style={sectionStyle}>待处理</div>
            {pending.length === 0 ? (
              <div style={emptyStyle}>暂无待处理任务</div>
            ) : (
              pending.map(renderPendingCard)
            )}
            <div style={sectionStyle}>已完成</div>
            {completed.length === 0 ? (
              <div style={emptyStyle}>暂无已完成任务</div>
            ) : (
              completed.map(renderCompletedCard)
            )}
          </>
        )}
      </div>
    </div>
  );
}
