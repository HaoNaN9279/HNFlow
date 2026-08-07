// T3 系统通知服务：工作流运行完成 → 桌面通知。
// 拆分原则：buildRunNotification 纯函数可独立验证（bun test 直跑，不碰 electron）；
// sendNotification 为 electron 薄层——electron 经动态 import 隔离在函数内，import 本模块不触发 electron 加载，
// Notification 构造/显示异常 catch 静默，通知失败不崩 main 进程。

/** 运行完成通知信息：与 run.ts 的 RunDoneInfo 形状一致（ok=结果、runId=引擎实际 runId、message=失败原因）。 */
export interface RunNotificationInfo {
  readonly ok: boolean;
  readonly runId: string;
  readonly message?: string;
}

/** 组装运行完成桌面通知内容（纯函数，无 electron 依赖）：
 *  成功 → 标题「工作流运行完成」+ 正文 runId；失败 → 标题「工作流运行失败」+ 正文 message/兜底文案 + runId。 */
export function buildRunNotification(info: RunNotificationInfo): { readonly title: string; readonly body: string } {
  if (info.ok) {
    return { title: "工作流运行完成", body: `运行 ID：${info.runId}` };
  }
  const reason = info.message === undefined ? "工作流运行失败" : info.message;
  return { title: "工作流运行失败", body: `${reason}（运行 ID：${info.runId}）` };
}

/** 发送桌面通知：electron 薄层（仅主进程调用）。
 *  electron 经动态 import 隔离在函数内：测试 import 本模块不加载 electron，纯函数可独立测试；
 *  构造/显示异常 catch 静默（通知失败不崩 main，不抛给调用方）。 */
export function sendNotification(title: string, body: string): void {
  void import("electron")
    .then(({ Notification }) => {
      new Notification({ title, body }).show();
    })
    .catch(() => {
      // 通知失败静默吞掉：electron 缺失 / Notification 构造/显示异常统一收敛，不崩 main。
    });
}
