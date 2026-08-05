// 功能组版本通知（v0.3.2 T1）：对比工作流依赖快照 resolvedGroups 与各组 currentVersion，输出可升级列表。
// 纯函数：仅读取 group.json，不写文件。T2 升级遍历将复用本报告驱动版本递增。
import { loadVersion, scanGroups } from "./load.js";
import { compareSemVer, parseSemVer } from "./semver.js";
import type { Workflow } from "../model/types.js";
import type { CapabilityGroup } from "./types.js";

/** 版本差异分类。 */
export type VersionDiff = "major" | "minor" | "patch";

/** 单个功能组的升级提示。 */
export interface GroupUpdateEntry {
  readonly guid: string;
  readonly namespace: string;
  readonly lockedVersion: string; // 工作流快照锁定的版本
  readonly latestVersion: string; // 当前最新版本（group.currentVersion）
  readonly diff: VersionDiff;     // latest vs locked 的差异分类
}

/** 版本通知报告。 */
export interface GroupUpdatesReport {
  readonly entries: readonly GroupUpdateEntry[];
  readonly ignoredCount: number;
}

export interface CheckUpdatesOptions {
  /** 忽略列表："guid@version" 字符串数组；忽略匹配 lockedVersion（快照锁定版本）的项，不进入 entries。 */
  readonly ignores?: readonly string[];
}

/** 解析快照条目 "guid@version"；无 "@" 或版本段为空时返回 undefined（防御跳过）。 */
function parseSnapshotEntry(entry: string): { guid: string; version: string } | undefined {
  const at = entry.lastIndexOf("@");
  if (at <= 0 || at === entry.length - 1) return undefined;
  return { guid: entry.slice(0, at), version: entry.slice(at + 1) };
}

/** 计算 latest 相对 locked 的差异分类（仅在 latest > locked 时调用）。 */
function classifyDiff(latest: string, locked: string): VersionDiff {
  const latestParsed = parseSemVer(latest);
  const lockedParsed = parseSemVer(locked);
  if (latestParsed.major !== lockedParsed.major) return "major";
  if (latestParsed.minor !== lockedParsed.minor) return "minor";
  return "patch";
}

/**
 * 对比工作流依赖快照与各组当前版本，输出可升级列表。
 * - 无 resolvedGroups（undefined / 空数组）→ 空报告；
 * - 快照条目引用的组不存在、格式非法或锁定版本已删除：防御跳过，不抛错；
 * - 忽略列表精确匹配 "guid@lockedVersion"：跳过并计入 ignoredCount。
 */
export async function checkGroupUpdates(
  rootDir: string,
  workflow: Workflow,
  options?: CheckUpdatesOptions,
): Promise<GroupUpdatesReport> {
  const resolvedGroups = workflow.resolvedGroups;
  if (resolvedGroups === undefined || resolvedGroups.length === 0) {
    return { entries: [], ignoredCount: 0 };
  }

  const groups = await scanGroups(rootDir);
  const byGuid = new Map<string, CapabilityGroup>(groups.map((group) => [group.guid, group]));
  const ignores = new Set(options?.ignores ?? []);

  const entries: GroupUpdateEntry[] = [];
  let ignoredCount = 0;

  for (const snapshot of resolvedGroups) {
    const parsed = parseSnapshotEntry(snapshot);
    if (parsed === undefined) continue;
    const group = byGuid.get(parsed.guid);
    if (group === undefined) continue;
    const lockedVersion = parsed.version;
    // 防御：快照可能引用已删除的版本（组已发布但历史被清理）。
    if (loadVersion(group, lockedVersion) === undefined) continue;

    // 忽略过滤：精确匹配 "guid@lockedVersion"，忽略项不因锁定版本差异误判。
    const ignoreKey = `${group.guid}@${lockedVersion}`;
    if (ignores.has(ignoreKey)) {
      ignoredCount += 1;
      continue;
    }

    const latestVersion = group.currentVersion;
    // 已是最新或快照版本超前：不进入升级列表。
    if (compareSemVer(parseSemVer(latestVersion), parseSemVer(lockedVersion)) <= 0) continue;

    entries.push({
      guid: group.guid,
      namespace: group.namespace,
      lockedVersion,
      latestVersion,
      diff: classifyDiff(latestVersion, lockedVersion),
    });
  }

  return { entries, ignoredCount };
}
