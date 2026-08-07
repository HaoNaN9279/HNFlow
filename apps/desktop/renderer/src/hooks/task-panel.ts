// 人工任务面板数据映射纯函数（v0.9.3；无 DOM 依赖，bun test 直跑可单测）。
// - splitTasks：按 status 分组——待处理区只含 "pending"，已完成区只含 "completed"；
//   skipped/deferred 不入面板（跳过/延迟由引擎侧标记，面板不展示）；
// - formatTaskTime：时间戳转本地可读时间字符串；
// - formatTaskResult：人工产物摘要（string 原样；其余 JSON 序列化；无结果兜底文案）。

import type { TaskSummary } from "../../../src/shared/ipc.js";

/** 任务分组结果：pending/completed 两区（skipped/deferred 不展示）。 */
export interface SplitTasksResult {
  readonly pending: readonly TaskSummary[];
  readonly completed: readonly TaskSummary[];
}

/** 按状态分组：pending 只含 "pending"，completed 只含 "completed"。 */
export function splitTasks(tasks: readonly TaskSummary[]): SplitTasksResult {
  const pending: TaskSummary[] = [];
  const completed: TaskSummary[] = [];
  for (const task of tasks) {
    if (task.status === "pending") {
      pending.push(task);
    } else if (task.status === "completed") {
      completed.push(task);
    }
  }
  return { pending, completed };
}

/** 时间戳 → 本地可读时间字符串（toLocaleString 依赖运行环境 locale）。 */
export function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/** 人工产物摘要：字符串原样；空/缺省兜底文案；其余 JSON 序列化（失败时 String 兜底）。 */
export function formatTaskResult(result: unknown): string {
  if (result === undefined || result === null || result === "") {
    return "（无结果）";
  }
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
