// 人工任务超时纯函数单测（v0.9.3）：扫描边界（无/部分/空/阈值边界）+ 文案（分钟取整/含标题节点名）。
import { describe, expect, it } from "bun:test";
import type { HumanTask } from "../src/human/types.js";
import {
  buildTimeoutMessage,
  scanPendingTimeouts,
  TASK_TIMEOUT_DEFAULT_MS,
} from "../src/human/task-timeout.js";

/** 构造最小 HumanTask；overrides 覆盖默认字段（含状态）。 */
function makeTask(overrides: Partial<HumanTask> = {}): HumanTask {
  return {
    id: "task-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    nodeName: "审批节点",
    title: "审批预算",
    status: "pending",
    fallback: "manual",
    createdAt: 1_000_000,
    ...overrides,
  };
}

describe("scanPendingTimeouts", () => {
  it("空列表返回空数组", () => {
    expect(scanPendingTimeouts([], 2_000_000, TASK_TIMEOUT_DEFAULT_MS)).toEqual([]);
  });

  it("全部未超时返回空数组（createdAt + thresholdMs < now 才超时）", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", createdAt: 1_500_000 })];
    expect(scanPendingTimeouts(tasks, 1_500_000, TASK_TIMEOUT_DEFAULT_MS)).toEqual([]);
  });

  it("边界：createdAt + thresholdMs === now 不算超时（严格小于）", () => {
    const tasks = [makeTask({ createdAt: 1_000_000 })];
    expect(scanPendingTimeouts(tasks, 1_000_000 + TASK_TIMEOUT_DEFAULT_MS, TASK_TIMEOUT_DEFAULT_MS)).toEqual([]);
  });

  it("部分超时：仅过滤 pending 且超时的任务，非 pending 忽略", () => {
    const tasks = [
      makeTask({ id: "a", createdAt: 1_000_000, status: "pending" }), // 超时
      makeTask({ id: "b", createdAt: 1_000_000, status: "completed" }), // 非 pending 忽略
      makeTask({ id: "c", createdAt: 1_000_000, status: "skipped" }),
      makeTask({ id: "d", createdAt: 1_000_000, status: "deferred" }),
      makeTask({ id: "e", createdAt: 1_900_000, status: "pending" }), // 未超时
    ];
    const now = 2_000_000;
    const thresholdMs = 500_000; // a: 1_000_000+500_000=1_500_000 < now 超时；e: 1_900_000+500_000 > now 未超时
    const result = scanPendingTimeouts(tasks, now, thresholdMs);
    expect(result).toHaveLength(1);
    expect(result[0]?.taskId).toBe("a");
  });

  it("thresholdMs=0：所有 pending 均超时", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    const result = scanPendingTimeouts(tasks, 1_500_000, 0);
    expect(result.map((t) => t.taskId)).toEqual(["a", "b"]);
  });

  it("thresholdMs 为负：所有 pending 均超时", () => {
    const tasks = [makeTask({ id: "a" })];
    expect(scanPendingTimeouts(tasks, 1_500_000, -1000)).toHaveLength(1);
  });

  it("overdueMs 计算：now - (createdAt + thresholdMs)", () => {
    const now = 2_000_000;
    const thresholdMs = 100_000;
    const result = scanPendingTimeouts([makeTask({ createdAt: 1_000_000 })], now, thresholdMs);
    expect(result[0]?.overdueMs).toBe(now - (1_000_000 + thresholdMs));
    expect(result[0]?.overdueMs).toBeGreaterThan(0);
  });

  it("返回字段完整：taskId/title/nodeName/createdAt/overdueMs", () => {
    const now = 2_000_000;
    const result = scanPendingTimeouts([makeTask({ id: "a", createdAt: 1_000_000 })], now, 100_000);
    expect(result[0]).toEqual({
      taskId: "a",
      title: "审批预算",
      nodeName: "审批节点",
      createdAt: 1_000_000,
      overdueMs: 900_000,
    });
  });
});

describe("buildTimeoutMessage", () => {
  it("分钟取整：90 分钟 → 文案含 90", () => {
    const msg = buildTimeoutMessage({
      taskId: "a",
      title: "审批预算",
      nodeName: "审批节点",
      createdAt: 1_000_000,
      overdueMs: 90 * 60 * 1000,
    });
    expect(msg).toContain("90");
    expect(msg).toContain("审批预算");
    expect(msg).toContain("审批节点");
    expect(msg).toContain("请及时处理");
  });

  it("分钟取整：不足一分钟 → 0 分钟", () => {
    const msg = buildTimeoutMessage({
      taskId: "a",
      title: "审批预算",
      nodeName: "审批节点",
      createdAt: 1_000_000,
      overdueMs: 30_000,
    });
    expect(msg).toContain("0 分钟");
  });
});

describe("TASK_TIMEOUT_DEFAULT_MS", () => {
  it("默认阈值 24 小时", () => {
    expect(TASK_TIMEOUT_DEFAULT_MS).toBe(24 * 60 * 60 * 1000);
  });
});
