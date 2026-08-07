// 人工任务超时提醒纯函数（v0.9.3）：扫描超时 pending 任务 + 组装中文提醒文案。
// 无 electron/文件依赖，bun test 直测；扫描编排见 apps/desktop/src/task-timeout-scan.ts。
import type { HumanTask } from "./types.js";

/** 人工任务超时提醒默认阈值：24 小时（毫秒）。 */
export const TASK_TIMEOUT_DEFAULT_MS = 24 * 60 * 60 * 1000;

/** 超时人工任务信息：overdueMs 为已超时时长（正值，毫秒）。 */
export interface TimeoutTask {
  readonly taskId: string;
  readonly title: string;
  readonly nodeName: string;
  readonly createdAt: number;
  readonly overdueMs: number;
}

/**
 * 扫描超时人工任务：过滤 status === "pending" 且 createdAt + thresholdMs < now。
 * overdueMs = now - (createdAt + thresholdMs)，由过滤条件保证恒为正。
 * 边界：thresholdMs <= 0 时所有 pending 均超时；空列表 / 未超时返回 []。
 */
export function scanPendingTimeouts(
  tasks: readonly HumanTask[],
  now: number,
  thresholdMs: number,
): readonly TimeoutTask[] {
  return tasks
    .filter((task) => task.status === "pending" && task.createdAt + thresholdMs < now)
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      nodeName: task.nodeName,
      createdAt: task.createdAt,
      overdueMs: now - (task.createdAt + thresholdMs),
    }));
}

/** 组装人工任务超时提醒文案：中文；overdueMs 转分钟取整。 */
export function buildTimeoutMessage(task: TimeoutTask): string {
  const minutes = Math.floor(task.overdueMs / (60 * 1000));
  return `人工任务「${task.title}」（${task.nodeName}）已超时 ${minutes} 分钟，请及时处理`;
}
