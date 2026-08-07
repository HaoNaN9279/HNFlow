// T2 窗口生命周期纯逻辑单测（无 electron，bun test 直跑）。
// 运行方式：仓库根 `bun test apps/desktop/src/__tests__/window-lifecycle.test.ts`。
import { describe, expect, it } from "bun:test";
import {
  CLOSE_BUTTON_ORDER,
  CLOSE_CHOICES,
  CLOSE_DIALOG_BUTTONS,
  closePromptMessage,
  decideClose,
  shouldConfirmClose,
} from "../window-lifecycle.js";

describe("shouldConfirmClose", () => {
  it("无运行任务（0）不确认", () => {
    expect(shouldConfirmClose(0)).toBe(false);
  });

  it("有运行任务（>0）确认", () => {
    expect(shouldConfirmClose(1)).toBe(true);
    expect(shouldConfirmClose(3)).toBe(true);
  });
});

describe("closePromptMessage", () => {
  it("中文提示包含运行数量", () => {
    expect(closePromptMessage(2)).toBe("有 2 个工作流正在运行，是否后台继续？");
  });
});

describe("decideClose", () => {
  it("后台继续 → 隐藏窗口", () => {
    expect(decideClose(CLOSE_CHOICES.hide, 1)).toEqual({ hide: true });
  });

  it("退出应用 → 不隐藏（调用方执行 quit）", () => {
    expect(decideClose(CLOSE_CHOICES.quit, 1)).toEqual({ hide: false });
  });
});

describe("按钮与决策键对齐", () => {
  it("对话框文案顺序与决策键顺序一致", () => {
    expect(CLOSE_DIALOG_BUTTONS).toEqual(["后台继续", "退出应用", "取消"]);
    expect(CLOSE_BUTTON_ORDER).toEqual(["hide", "quit", "cancel"]);
  });
});
