// 功能组加载（v0.3.0 T1）：group.json 读取/校验 + groups/ 目录递归扫描。
// 仅做定义解析，不读取版本目录内容（T2/T3 范围）。
// 目录结构：groups/<namespace 路径>/group.json + v<version>/ 版本目录。
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { GroupFileError, GroupScanError } from "./errors.js";
import { parseSemVer } from "./semver.js";
import type { CapabilityGroup, GroupContent, GroupDependency, GroupVersion, RuleEntry } from "./types.js";

// ---- zod schemas：group.json 边界校验，字段与 types.ts 契约对齐（惯例同 src/model/schemas.ts）----

const ruleEntrySchema: z.ZodType<RuleEntry> = z.object({
  path: z.string(),
  order: z.number(),
});

const groupDependencySchema: z.ZodType<GroupDependency> = z.object({
  guid: z.string(),
  versionRange: z.string(),
});

const groupContentSchema: z.ZodType<GroupContent> = z.object({
  agent: z.string().exactOptional(),              // 相对版本目录路径
  tools: z.array(z.string()),                     // 相对版本目录文件名/路径数组
  mcps: z.array(z.string()),                      // 相对版本目录文件名/路径数组
  rules: z.array(ruleEntrySchema),
  requiresCoreVersion: z.string().exactOptional(),
  dependencies: z.array(groupDependencySchema).exactOptional(),
});

const isSemverString = (value: string): boolean => {
  try {
    parseSemVer(value);
    return true;
  } catch {
    return false;
  }
};

const groupVersionSchema: z.ZodType<GroupVersion> = z.object({
  version: z.string().refine(isSemverString, { message: "版本号必须为严格语义版本号 x.y.z" }),
  createdAt: z.string(),
  changelog: z.string(),
  content: groupContentSchema,
});

/** group.json 校验 schema：输出即 CapabilityGroup。 */
export const groupJsonSchema: z.ZodType<CapabilityGroup> = z.object({
  guid: z.string().min(1, { message: "guid 不能为空" }),
  namespace: z.string().min(1, { message: "namespace 不能为空" }),
  aliases: z.array(z.string()), // 元素非字符串时校验失败
  description: z.string(),
  versions: z.array(groupVersionSchema).min(1, { message: "至少需要一个版本" }),
  currentVersion: z.string().refine(isSemverString, { message: "currentVersion 必须为合法语义版本号 x.y.z" }),
});

// ---- 加载与扫描 ----

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 加载单个功能组定义：读取 dir/group.json 并校验。文件缺失 / JSON 非法 / 校验失败抛 GroupFileError。 */
export async function loadGroup(dir: string): Promise<CapabilityGroup> {
  const filePath = join(dir, "group.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new GroupFileError(`读取 group.json 失败：${filePath}（${describeError(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GroupFileError(`group.json 不是合法 JSON：${filePath}（${describeError(error)}）`);
  }
  const result = groupJsonSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(根)"}：${issue.message}`).join("；");
    throw new GroupFileError(`group.json 校验失败：${filePath}（${issues}）`);
  }
  const group = result.data;
  // currentVersion 必须存在于 versions 中（schema 无法直接跨字段校验，此处二次确认）。
  if (!group.versions.some((version) => version.version === group.currentVersion)) {
    throw new GroupFileError(
      `group.json 校验失败：${filePath}（currentVersion "${group.currentVersion}" 不在 versions 中）`,
    );
  }
  return group;
}

/** 相对路径转 posix 分隔符：namespace 统一用 "/"（Windows 下 relative 返回反斜杠）。 */
function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * 递归扫描 rootDir 下所有含 group.json 的功能组目录（目录深度不限）。
 * namespace = 相对 rootDir 的路径（如 "web/scraping/playwright"），以 group.json 声明为准。
 * - 无 group.json 的分组目录（如 web/）跳过并继续下钻；
 * - 单个 group.json 损坏：console.warn 跳过该组，不中断整体扫描；
 * - 目录内 namespace 与路径不一致：console.warn（路径可重命名，group.json 为准）；
 * - rootDir 不存在 / 不是目录：抛 GroupScanError。
 * 返回按 namespace 字典序排序。
 */
export async function scanGroups(rootDir: string): Promise<CapabilityGroup[]> {
  let rootInfo;
  try {
    rootInfo = await stat(rootDir);
  } catch {
    throw new GroupScanError(`功能组根目录不存在或不可访问：${rootDir}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new GroupScanError(`功能组根目录不是目录：${rootDir}`);
  }

  const groups: CapabilityGroup[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.warn(`跳过无法读取的目录 "${dir}"：${describeError(error)}`);
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "group.json")) {
      try {
        const group = await loadGroup(dir);
        const pathNamespace = toPosixPath(relative(rootDir, dir));
        if (group.namespace !== pathNamespace) {
          console.warn(
            `功能组 namespace 与目录路径不一致：group.json 声明 "${group.namespace}"，目录路径 "${pathNamespace}"（以 group.json 为准）`,
          );
        }
        groups.push(group);
      } catch (error) {
        // 单个损坏的 group.json 不致命：跳过并警告，保留其他功能组。
        console.warn(`跳过损坏的功能组目录 "${dir}"：${describeError(error)}`);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
      }
    }
  }

  await walk(rootDir);
  groups.sort((a, b) => a.namespace.localeCompare(b.namespace));
  return groups;
}

/** 按 namespace 查找（含 aliases 匹配），未命中返回 undefined。 */
export async function findGroup(rootDir: string, namespace: string): Promise<CapabilityGroup | undefined> {
  const groups = await scanGroups(rootDir);
  return groups.find((group) => group.namespace === namespace || group.aliases.includes(namespace));
}

/** 按 GUID 查找，未命中返回 undefined。 */
export async function findGroupByGuid(rootDir: string, guid: string): Promise<CapabilityGroup | undefined> {
  const groups = await scanGroups(rootDir);
  return groups.find((group) => group.guid === guid);
}

/** 从 versions 按版本号取版本快照，未命中返回 undefined。版本目录路径约定 = 功能组目录/v<version>/。 */
export function loadVersion(group: CapabilityGroup, version: string): GroupVersion | undefined {
  return group.versions.find((candidate) => candidate.version === version);
}
