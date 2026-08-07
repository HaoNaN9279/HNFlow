// T2 运行计数纯逻辑单测（无 electron，bun test 直跑）。
// 模块级计数跨测试共享：单 it 覆盖全部行为，用 base 抵消初始状态避免顺序依赖。
import { describe, expect, it } from "bun:test";
import { decrement, getActiveRuns, increment } from "../run-tracker.js";

describe("run-tracker", () => {
  it("increment/decrement/getActiveRuns 增减一致且不降到负数", () => {
    const base = getActiveRuns();
    increment();
    increment();
    expect(getActiveRuns()).toBe(base + 2);
    decrement();
    expect(getActiveRuns()).toBe(base + 1);
    decrement();
    expect(getActiveRuns()).toBe(base);
    for (let i = 0; i < 3; i += 1) {
      decrement(); // 过度递减：防御不降到负数
    }
    expect(getActiveRuns()).toBe(0);
  });
});
