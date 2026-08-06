// debug/format.ts 纯函数单测（无 DOM/X6 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/debug/__tests__/format.test.ts`。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { DebugContextSnapshot, IpcLogEntry } from "../../../../src/shared/ipc.js";
import {
  filterLogsByLevel,
  flattenSnapshotNodes,
  logLevelColor,
  nodeStatusMeta,
  summarizeValue,
} from "../format.js";

function log(level: IpcLogEntry["level"], message: string, data?: unknown): IpcLogEntry {
  return { level, message, data };
}

describe("filterLogsByLevel", () => {
  it("all 保留全部日志且保持原序", () => {
    const logs = [log("info", "a"), log("warn", "b"), log("error", "c")];
    expect(filterLogsByLevel(logs, "all")).toEqual(logs);
  });

  it("按级别过滤只留匹配条目", () => {
    const logs = [log("info", "a"), log("warn", "b"), log("error", "c")];
    expect(filterLogsByLevel(logs, "warn").map((entry) => entry.message)).toEqual(["b"]);
  });

  it("空列表返回空列表", () => {
    expect(filterLogsByLevel([], "error")).toEqual([]);
  });
});

describe("logLevelColor", () => {
  it("info 灰 / warn 橙 / error 红", () => {
    expect(logLevelColor("info")).toBe("#8c8c8c");
    expect(logLevelColor("warn")).toBe("#fa8c16");
    expect(logLevelColor("error")).toBe("#ff4d4f");
  });
});

describe("nodeStatusMeta", () => {
  it("七个状态各有中文标签与颜色", () => {
    expect(nodeStatusMeta("Idle")).toEqual({ color: "#8c8c8c", label: "空闲" });
    expect(nodeStatusMeta("Running")).toEqual({ color: "#1677ff", label: "运行中" });
    expect(nodeStatusMeta("Success")).toEqual({ color: "#52c41a", label: "成功" });
    expect(nodeStatusMeta("Failed")).toEqual({ color: "#ff4d4f", label: "失败" });
    expect(nodeStatusMeta("Skipped")).toEqual({ color: "#d9d9d9", label: "跳过" });
    expect(nodeStatusMeta("WaitingForHuman")).toEqual({ color: "#fa8c16", label: "待人工" });
    expect(nodeStatusMeta("Paused")).toEqual({ color: "#722ed1", label: "已暂停" });
  });

  it("运行/失败/待人工用警示色（蓝/红/橙）", () => {
    expect(["#1677ff", "#ff4d4f", "#fa8c16"]).toContain(nodeStatusMeta("Running").color);
    expect(["#1677ff", "#ff4d4f", "#fa8c16"]).toContain(nodeStatusMeta("Failed").color);
    expect(["#1677ff", "#ff4d4f", "#fa8c16"]).toContain(nodeStatusMeta("WaitingForHuman").color);
  });
});

describe("summarizeValue", () => {
  it("短字符串原样返回", () => {
    expect(summarizeValue("hello", 10)).toBe("hello");
  });

  it("长字符串按 maxLen 截断加省略号", () => {
    expect(summarizeValue("hello world", 5)).toBe("hello…");
  });

  it("非字符串 JSON 序列化后再截断", () => {
    expect(summarizeValue({ a: [1, 2, 3] }, 100)).toBe('{"a":[1,2,3]}');
    expect(summarizeValue({ a: [1, 2, 3] }, 6)).toBe('{"a":[…');
  });

  it("循环引用兜底 String 不抛错", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarizeValue(cyclic, 50)).toBe("[object Object]");
  });
});

describe("flattenSnapshotNodes", () => {
  it("node 层 `node:<id>` → 条目（nodeId 去前缀，variables 原样）", () => {
    const snapshot: DebugContextSnapshot = {
      global: {},
      workflow: {},
      node: { "node:a1": { value: 1 }, "node:b2": { value: 2 } },
    };
    const items = flattenSnapshotNodes(snapshot);
    expect(items).toEqual([
      { key: "node:a1", nodeId: "a1", variables: { value: 1 } },
      { key: "node:b2", nodeId: "b2", variables: { value: 2 } },
    ]);
  });

  it("无 node 层 → 空数组", () => {
    const snapshot: DebugContextSnapshot = { global: {}, workflow: {}, node: {} };
    expect(flattenSnapshotNodes(snapshot)).toEqual([]);
  });

  it("key 无 node: 前缀时按原样作 nodeId（防御）", () => {
    const snapshot: DebugContextSnapshot = { global: {}, workflow: {}, node: { raw: { v: 1 } } };
    expect(flattenSnapshotNodes(snapshot)[0]?.nodeId).toBe("raw");
  });
});
