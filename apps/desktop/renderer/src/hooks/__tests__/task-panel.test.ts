// task-panel.ts 纯函数单测（无 DOM/X6 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/hooks/__tests__/task-panel.test.ts`。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { TaskSummary } from "../../../../src/shared/ipc.js";
import { formatTaskResult, formatTaskTime, splitTasks } from "../task-panel.js";

/** 便捷构造任务摘要：status 必传，其余字段可覆盖。 */
function task(status: TaskSummary["status"], overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: `t-${status}`,
    workflowId: "wf-1",
    nodeId: "node-1",
    nodeName: "测试节点",
    title: "测试任务",
    status,
    fallback: "manual",
    createdAt: new Date("2026-08-07T10:30:00").getTime(),
    ...overrides,
  };
}

describe("splitTasks 分组", () => {
  it("pending 区只含 pending 任务", () => {
    const { pending, completed } = splitTasks([
      task("pending"),
      task("completed"),
      task("skipped"),
      task("deferred"),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.status).toBe("completed");
  });

  it("skipped/deferred 不入任何区", () => {
    const { pending, completed } = splitTasks([task("skipped"), task("deferred")]);
    expect(pending).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  it("空输入返回两个空数组", () => {
    const { pending, completed } = splitTasks([]);
    expect(pending).toEqual([]);
    expect(completed).toEqual([]);
  });

  it("多任务分组计数正确", () => {
    const { pending, completed } = splitTasks([
      task("pending"),
      task("pending"),
      task("completed"),
      task("completed"),
      task("completed"),
    ]);
    expect(pending).toHaveLength(2);
    expect(completed).toHaveLength(3);
  });
});

describe("formatTaskTime", () => {
  it("时间戳转本地可读字符串（含年份）", () => {
    const text = formatTaskTime(new Date("2026-08-07T10:30:00").getTime());
    expect(typeof text).toBe("string");
    expect(text).toContain("2026");
  });

  it("0 时间戳仍返回字符串", () => {
    expect(typeof formatTaskTime(0)).toBe("string");
  });
});

describe("formatTaskResult", () => {
  it("字符串原样返回", () => {
    expect(formatTaskResult("已完成")).toBe("已完成");
  });

  it("undefined/空字符串兜底", () => {
    expect(formatTaskResult(undefined)).toBe("（无结果）");
    expect(formatTaskResult("")).toBe("（无结果）");
  });

  it("对象 JSON 序列化", () => {
    expect(formatTaskResult({ file: "a.txt", lines: 3 })).toBe('{"file":"a.txt","lines":3}');
  });

  it("数值转字符串", () => {
    expect(formatTaskResult(42)).toBe("42");
  });
});
