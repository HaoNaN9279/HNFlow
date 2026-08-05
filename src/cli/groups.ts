// groups/group 子命令（v0.3.0 T7）：功能组 CLI 入口。
// groups list 列出现有功能组；group init 创建（GUID + v0.1.0）；group release 发布新版本并同步索引库；group history 列出版本历史。
// 索引库（<dir>/.hnflow-groups.db）仅作加速查询，解析始终以 group.json 为准——同步失败只警告，不阻断 release 成功。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { GroupFileError } from "../groups/errors.js";
import { openGroupIndex } from "../groups/index-store.js";
import { initGroup, validateNamespace } from "../groups/init.js";
import { loadGroup, scanGroups } from "../groups/load.js";
import { collectResources, releaseGroup } from "../groups/release.js";
import { compareSemVer, parseSemVer } from "../groups/semver.js";
import type { CapabilityGroup } from "../groups/types.js";
import { describeError, fail, printTable } from "./util.js";

const DEFAULT_DIR = "./groups";
const INDEX_FILE = ".hnflow-groups.db";

/** bun run src/cli/index.ts groups <子命令> ... */
export async function cmdGroups(args: readonly string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "list":
      return cmdGroupsList(args.slice(1));
    case undefined:
      return fail("缺少子命令", "groups list");
    default:
      return fail(`未知子命令: ${sub}`, "groups list");
  }
}

/** bun run src/cli/index.ts group <子命令> ... */
export async function cmdGroup(args: readonly string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "init":
      return cmdGroupInit(args.slice(1));
    case "release":
      return cmdGroupRelease(args.slice(1));
    case "history":
      return cmdGroupHistory(args.slice(1));
    case undefined:
      return fail("缺少子命令", "group init|release|history");
    default:
      return fail(`未知子命令: ${sub}`, "group init|release|history");
  }
}

/** groups list [dir]：列出功能组表格；空目录提示；根目录缺失 fail。 */
async function cmdGroupsList(args: readonly string[]): Promise<number> {
  const dir = args[0] ?? DEFAULT_DIR;
  let groups: CapabilityGroup[];
  try {
    groups = await scanGroups(dir);
  } catch (error) {
    return fail(describeError(error), "groups list [dir]");
  }
  if (groups.length === 0) {
    console.log(`目录 ${dir} 下没有功能组`);
    return 0;
  }
  printTable(
    ["namespace", "guid", "currentVersion", "版本数", "aliases"],
    groups.map((group) => [
      group.namespace,
      group.guid.slice(0, 8),
      group.currentVersion,
      String(group.versions.length),
      group.aliases.join(", "),
    ]),
  );
  return 0;
}

/** group init <namespace> [dir]：创建功能组，打印 GUID/namespace/初始版本。 */
async function cmdGroupInit(args: readonly string[]): Promise<number> {
  const usage = "group init <namespace> [dir]";
  const namespace = args[0];
  if (namespace === undefined) return fail("缺少 namespace", usage);
  const dir = args[1] ?? DEFAULT_DIR;
  try {
    const group = await initGroup(dir, namespace);
    console.log(`GUID: ${group.guid}`);
    console.log(`namespace: ${group.namespace}`);
    console.log(`初始版本: v${group.currentVersion}`);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** 目录存在性判断：stat 失败（不存在/不可访问）返回 false。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** group history <namespace> [dir]：列出版本历史表格（语义版本降序，当前版本在最上）。 */
async function cmdGroupHistory(args: readonly string[]): Promise<number> {
  const usage = "group history <namespace> [dir]";
  const namespace = args[0];
  if (namespace === undefined) return fail("缺少 namespace", usage);
  const dir = args[1] ?? DEFAULT_DIR;
  try {
    const normalized = validateNamespace(namespace);
    const groupDir = join(dir, ...normalized.split("/"));
    if (!(await isDirectory(groupDir))) {
      throw new GroupFileError(`功能组不存在：${normalized}（${groupDir}）`);
    }
    const group = await loadGroup(groupDir);
    // 语义版本降序：字符串排序会把 "1.10.0" 排在 "1.9.0" 前（错误），必须 parseSemVer + compareSemVer。
    const sorted = [...group.versions].sort((a, b) => -compareSemVer(parseSemVer(a.version), parseSemVer(b.version)));
    printTable(
      ["版本", "创建时间", "changelog"],
      sorted.map((version) => [version.version, version.createdAt, version.changelog]),
    );
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** group release 参数解析结果：error 非空时直接 fail（缺值 / 未知选项 / 多余参数）。 */
interface ReleaseArgs {
  namespace?: string;
  dir?: string;
  version?: string;
  changelog?: string;
  error?: string;
}

/** 手工解析 group release 参数：-v 必填 / -c 可选；位置参数依次为 namespace、dir。 */
function parseReleaseArgs(args: readonly string[]): ReleaseArgs {
  const result: ReleaseArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // noUncheckedIndexedAccess 越界防御
    if (arg === "-v" || arg === "-c") {
      const value = args[i + 1];
      if (value === undefined) return { error: `选项 ${arg} 缺少值` };
      if (arg === "-v") result.version = value;
      else result.changelog = value;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知选项: ${arg}` };
    positional.push(arg);
  }
  if (positional[0] !== undefined) result.namespace = positional[0];
  if (positional[1] !== undefined) result.dir = positional[1];
  if (positional[2] !== undefined) return { error: `多余参数: ${positional[2]}` };
  return result;
}

/** group release <namespace> -v <version> [dir] [-c <changelog>]：发布新版本并同步索引。 */
async function cmdGroupRelease(args: readonly string[]): Promise<number> {
  const usage = "group release <namespace> -v <version> [dir] [-c <changelog>]";
  const parsed = parseReleaseArgs(args);
  if (parsed.error !== undefined) return fail(parsed.error, usage);
  const namespace = parsed.namespace;
  const version = parsed.version;
  if (namespace === undefined) return fail("缺少 namespace", usage);
  if (version === undefined) return fail("缺少版本号（-v <version>）", usage);
  // 格式校验前置：namespace/version 非法直接 fail（含用法），不触碰文件系统。
  try {
    validateNamespace(namespace);
    parseSemVer(version);
  } catch (error) {
    return fail(describeError(error), usage);
  }
  const dir = parsed.dir ?? DEFAULT_DIR;
  try {
    const released = await releaseGroup(dir, namespace, version, parsed.changelog);
    console.log(`namespace: ${released.group.namespace}`);
    console.log(`新版本: v${released.group.currentVersion}`);
    console.log(`changelog: ${parsed.changelog ?? "更新"}`);
    if (released.compat !== undefined) {
      console.log(`兼容性: ${released.compat.level}（${released.compat.changes.length} 项变更）`);
    }
    await syncIndex(dir, released.group);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/**
 * 同步功能组索引库（<dir>/.hnflow-groups.db）：upsert 组行 + 新版本资源行。
 * 索引仅作加速，解析以 group.json 为准——失败仅警告，不阻断 release 成功。
 */
async function syncIndex(rootDir: string, group: CapabilityGroup): Promise<void> {
  try {
    const index = await openGroupIndex(join(rootDir, INDEX_FILE));
    try {
      await index.upsertGroup({
        guid: group.guid,
        namespace: group.namespace,
        currentVersion: group.currentVersion,
        aliases: group.aliases,
        description: group.description,
        updatedAt: Date.now(),
      });
      const versionDir = join(rootDir, ...group.namespace.split("/"), `v${group.currentVersion}`);
      const resources = await collectResources(versionDir);
      await index.upsertResources(
        resources.map((resource) => ({ ...resource, guid: group.guid, version: group.currentVersion })),
      );
    } finally {
      await index.close();
    }
  } catch (error) {
    console.warn(`警告: 索引同步失败（仅影响加速查询，解析仍以 group.json 为准）: ${describeError(error)}`);
  }
}
