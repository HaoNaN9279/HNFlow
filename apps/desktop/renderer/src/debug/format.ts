// debug/format.ts：调试面板展示辅助纯函数（无 DOM/X6 依赖，可独立单测）。
// 覆盖：日志级别过滤/着色、节点状态徽标、值单行摘要、节点快照扁平化（`node:<id>` → 显示名）。
// IPC 边界类型从 shared/ipc.js 导入（renderer 侧只 import 类型，tsconfig types 仅 vite/client）。

import type { DebugContextSnapshot, DebugNodeStatus, IpcLogEntry } from "../../../src/shared/ipc.js";

/** 日志级别过滤器取值：all = 不过滤。 */
export type LogLevelFilter = "all" | IpcLogEntry["level"];

/** 按级别过滤日志：all 原样返回，否则仅保留匹配级别（时间顺序保持数组原序）。 */
export function filterLogsByLevel(logs: readonly IpcLogEntry[], level: LogLevelFilter): readonly IpcLogEntry[] {
  if (level === "all") {
    return logs;
  }
  return logs.filter((log) => log.level === level);
}

/** 日志级别 → 色点颜色（info 灰 / warn 橙 / error 红）。 */
export function logLevelColor(level: IpcLogEntry["level"]): string {
  switch (level) {
    case "info":
      return "#8c8c8c";
    case "warn":
      return "#fa8c16";
    case "error":
      return "#ff4d4f";
  }
}

/** 节点状态徽标信息：颜色 + 中文标签。 */
export interface NodeStatusMeta {
  readonly color: string;
  readonly label: string;
}

/** 节点状态 → 徽标（颜色 + 中文标签；Idle/Skipped 灰系、Running 蓝、Success 绿、Failed 红、WaitingForHuman 橙、Paused 紫）。 */
export function nodeStatusMeta(status: DebugNodeStatus): NodeStatusMeta {
  switch (status) {
    case "Idle":
      return { color: "#8c8c8c", label: "空闲" };
    case "Running":
      return { color: "#1677ff", label: "运行中" };
    case "Success":
      return { color: "#52c41a", label: "成功" };
    case "Failed":
      return { color: "#ff4d4f", label: "失败" };
    case "Skipped":
      return { color: "#d9d9d9", label: "跳过" };
    case "WaitingForHuman":
      return { color: "#fa8c16", label: "待人工" };
    case "Paused":
      return { color: "#722ed1", label: "已暂停" };
  }
}

/** 值 → 单行摘要：字符串原样；其他值 JSON 序列化（循环引用等兜底 String），超出 maxLen 截断加省略号。 */
export function summarizeValue(value: unknown, maxLen: number): string {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value); // 循环引用 / BigInt 等 JSON.stringify 抛错时兜底
    }
  }
  if (maxLen <= 0 || raw.length <= maxLen) {
    return raw;
  }
  return `${raw.slice(0, maxLen)}…`;
}

/** 节点快照条目：key 为原 `node:<id>`，nodeId 去前缀供画布定位。 */
export interface SnapshotNodeItem {
  readonly key: string;
  readonly nodeId: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

/** 节点快照扁平化：contextSnapshot.node（key 为 `node:<id>`）→ 展示条目数组（保持原顺序）。 */
export function flattenSnapshotNodes(snapshot: DebugContextSnapshot): readonly SnapshotNodeItem[] {
  return Object.entries(snapshot.node).map(([key, variables]) => ({
    key,
    nodeId: key.startsWith("node:") ? key.slice("node:".length) : key,
    variables,
  }));
}
