// 窗口生命周期纯逻辑（T2 托盘驻留 + 关闭确认）：关闭决策、提示文案、按钮定义。
// 与 electron 薄层分离：不 import electron，决策/文案可 bun test 直测。

/** 关闭确认按钮选择常量键（对话框三选）。 */
export const CLOSE_CHOICES = {
  /** 后台继续：隐藏窗口，运行中任务继续。 */
  hide: "hide",
  /** 退出应用：结束全部任务并退出。 */
  quit: "quit",
  /** 取消：窗口保持打开。 */
  cancel: "cancel",
} as const;

/** 关闭确认选择类型。 */
export type CloseChoice = (typeof CLOSE_CHOICES)[keyof typeof CLOSE_CHOICES];

/** 关闭确认对话框按钮文案（顺序与 CLOSE_BUTTON_ORDER 对齐）。 */
export const CLOSE_DIALOG_BUTTONS = ["后台继续", "退出应用", "取消"] as const;

/** 对话框响应索引 → 选择常量键（与 CLOSE_DIALOG_BUTTONS 顺序一致）。 */
export const CLOSE_BUTTON_ORDER: readonly CloseChoice[] = ["hide", "quit", "cancel"];

/** 有运行中任务（>0）才需要确认关闭。 */
export function shouldConfirmClose(activeRunCount: number): boolean {
  return activeRunCount > 0;
}

/** 关闭确认对话框中文提示：「有 N 个工作流正在运行，是否后台继续？」 */
export function closePromptMessage(activeRunCount: number): string {
  return `有 ${activeRunCount} 个工作流正在运行，是否后台继续？`;
}

/**
 * 按用户选择决策（activeRunCount 供调用方上下文使用，本轮决策只看选择）：
 * 后台继续 → { hide: true }（隐藏窗口，任务继续）；
 * 退出应用 → { hide: false }（调用方执行 app.quit）。
 * 取消由调用方拦截，不进入本决策。
 */
export function decideClose(choice: CloseChoice, _activeRunCount: number): { hide: boolean } {
  return { hide: choice === CLOSE_CHOICES.hide };
}
