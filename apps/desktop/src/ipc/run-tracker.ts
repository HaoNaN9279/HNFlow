// 运行计数（T2 托盘驻留/关闭确认）：主进程内存计数，供关闭确认判断是否有运行中任务。
// T1 接线：runWorkflowOnce 开始前 increment()、结束（finally）decrement()，由 T1 在 run.ts 接入。
// 纯内存计数：进程退出即清零，无需持久化。

/** 当前运行中任务数（主进程单实例内存计数）。 */
let activeRuns = 0;

/** 运行开始计数 +1，返回最新计数。 */
export function increment(): number {
  activeRuns += 1;
  return activeRuns;
}

/** 运行结束计数 -1（防御：不低于 0），返回最新计数。 */
export function decrement(): number {
  activeRuns = Math.max(0, activeRuns - 1);
  return activeRuns;
}

/** 当前运行中任务数（0 = 无运行任务，关窗不提示）。 */
export function getActiveRuns(): number {
  return activeRuns;
}
