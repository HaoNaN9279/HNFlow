// 人工任务超时扫描编排（v0.9.3）：listPending → scanPendingTimeouts → 逐条桌面通知。
// 与 notify.ts 同构：now/thresholdMs/notify 参数化注入，bun test 直测不碰 electron；
// notify 缺省 sendNotification（electron 经动态 import 隔离在函数内，import 本模块不触发 electron 加载）。
import type { HumanTaskStoreLike } from "../../../src/db/stores/types.js";
import {
  buildTimeoutMessage,
  scanPendingTimeouts,
  TASK_TIMEOUT_DEFAULT_MS,
} from "../../../src/human/task-timeout.js";
import { sendNotification } from "./notify.js";

/** 通知回调类型：注入 spy 可测；缺省 sendNotification。 */
export type NotifyFn = (title: string, body: string) => void;

/**
 * 扫描并通知超时人工任务：listPending → scanPendingTimeouts → 逐条通知。
 * now / thresholdMs / notify 均可注入（测试替身）；返回通知条数。
 * 读取/通知异常不在此收敛——由调用方（main.ts）try/catch 容错，失败不崩主进程。
 */
export async function scanAndNotify(
  store: Pick<HumanTaskStoreLike, "listPending">,
  now: number = Date.now(),
  thresholdMs: number = TASK_TIMEOUT_DEFAULT_MS,
  notify: NotifyFn = sendNotification,
): Promise<number> {
  const tasks = await store.listPending();
  const timeouts = scanPendingTimeouts(tasks, now, thresholdMs);
  for (const timeout of timeouts) {
    notify("人工任务超时提醒", buildTimeoutMessage(timeout));
  }
  return timeouts.length;
}
