// 功能组库纯逻辑（v0.4.3 验收 1）：种子初始化、扫描汇总，与 handlers.ts 分离（无 electron 依赖，可独立验证）。
// 目录结构：groups/<namespace 路径>/group.json + v<version>/ 版本目录（与核心库 src/groups 约定一致）。
// 错误翻译：核心库 GroupScanError/GroupFileError/GroupContentLoadError 消息已中文，透传；
// 单个功能组内容加载失败（文件缺失/非法）console.warn 跳过该组，不中断整体扫描（同 scanGroups 损坏处理惯例）。

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadGroupContent } from "../../../../src/groups/content-loader.js";
import { scanGroups } from "../../../../src/groups/load.js";
import type { GroupMcpSummary, GroupSummary, GroupToolSummary } from "../shared/ipc.js";
import { SEED_GROUPS, writeSeedGroup } from "./seed-groups.js";

/** 功能组库根目录名（位于 userData 下）。 */
export const GROUP_LIB_DIR = "groups";

/** 提取 fs 错误码（ENOENT/EACCES 等）；非 fs 错误返回 undefined。 */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 确保功能组库存在：目录缺失或为空 → 创建并写入种子功能组；非空 → 跳过。失败抛错（main 启动时 catch 告警）。 */
export async function ensureGroupLibrary(userDataDir: string): Promise<void> {
  const root = join(userDataDir, GROUP_LIB_DIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error; // 目录存在但不可读等错误直接上抛
    entries = []; // 目录不存在 → 视为空库，继续初始化
  }
  if (entries.length > 0) return; // 已有功能组 → 跳过种子写入（不覆盖用户数据）
  await mkdir(root, { recursive: true });
  for (const seed of SEED_GROUPS) {
    await writeSeedGroup(root, seed);
  }
}

/**
 * 扫描功能组库并汇总当前版本内容（只读）。
 * groupsRootDir 缺失/不可访问抛 GroupScanError（中文消息）；单个功能组内容加载失败跳过并警告。
 * 返回按 namespace 字典序排序。
 */
export async function scanGroupsSummary(groupsRootDir: string): Promise<readonly GroupSummary[]> {
  const groups = await scanGroups(groupsRootDir);
  const summaries: GroupSummary[] = [];
  for (const group of groups) {
    try {
      const content = await loadGroupContent(groupsRootDir, group, group.currentVersion);
      summaries.push({
        namespace: group.namespace,
        currentVersion: group.currentVersion,
        tools: content.tools.map((tool): GroupToolSummary => ({ name: tool.name, description: tool.description })),
        mcps: content.mcps.map((mcp): GroupMcpSummary => ({ name: mcp.name, config: mcp.config })),
      });
    } catch (error) {
      // 单个功能组内容损坏不致命：跳过并警告，保留其他功能组。
      console.warn(`跳过内容加载失败的功能组 "${group.namespace}"：${describeError(error)}`);
    }
  }
  return summaries;
}
