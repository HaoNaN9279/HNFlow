// 功能组 .hnflow-group 包导入还原（v0.9.1 T4）。
// 解析校验（format/formatVersion/JSON）+ 路径安全校验（防写盘逃逸）+ 冲突检测 + 写盘还原。
// 包格式契约见 plan.md；与 T3 export.ts 的 GroupPackage 契约一致（此处独立定义防循环依赖，结构兼容即可）。
// 元数据复用 load.ts groupJsonSchema 校验（deprecated 可选字段兼容旧数据）。
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
import { GroupFileError } from "./errors.js";
import { validateNamespace } from "./init.js";
import { groupJsonSchema, scanGroups } from "./load.js";
import { parseSemVer } from "./semver.js";
import type { CapabilityGroup } from "./types.js";

/** .hnflow-group 包格式（与 T3 export.ts 同名类型结构一致；独立定义防循环依赖）。 */
export interface GroupPackage {
  readonly format: "hnflow-group";
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly group: CapabilityGroup;
  /** 文件映射：路径（v<version>/ 前缀，posix 分隔）→ base64 内容。 */
  readonly files: Readonly<Record<string, string>>;
}

/** 版本目录前缀形状：v<数字>.<数字>.<数字>/；semver 段再用 parseSemVer 严格校验。 */
const VERSION_DIR_PATTERN = /^v\d+\.\d+\.\d+\//;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 校验包文件路径（安全关键，防写盘逃逸）：
 * 必须 "v<语义版本号>/" 前缀、无 ".."/"." 段、非绝对路径、无反斜杠（posix 风格）。
 * 校验通过返回原值。
 */
export function assertSafePackagePath(relPath: string): string {
  if (relPath === "") {
    throw new GroupFileError("包文件路径不能为空");
  }
  if (relPath.includes("\\")) {
    throw new GroupFileError(`包文件路径 "${relPath}" 非法：不能包含反斜杠（包内路径使用 "/" 分隔）`);
  }
  if (relPath.startsWith("/")) {
    throw new GroupFileError(`包文件路径 "${relPath}" 非法：不能为绝对路径`);
  }
  if (!VERSION_DIR_PATTERN.test(relPath)) {
    throw new GroupFileError(`包文件路径 "${relPath}" 非法：必须以 "v<语义版本号>/" 前缀开头`);
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === ".") {
      throw new GroupFileError(`包文件路径 "${relPath}" 非法：不能包含 "${segment}" 路径段`);
    }
  }
  const firstSegment = segments[0] ?? "";
  const version = firstSegment.slice(1); // 去 "v" 前缀
  try {
    parseSemVer(version);
  } catch {
    throw new GroupFileError(`包文件路径 "${relPath}" 非法：版本前缀必须为严格语义版本号 x.y.z`);
  }
  return relPath;
}

/** group 元数据校验：过 load.ts groupJsonSchema（含 deprecated 可选字段兼容）+ currentVersion 必须在 versions 中。 */
function validateGroupMetadata(group: unknown): CapabilityGroup {
  const result = groupJsonSchema.safeParse(group);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(根)"}：${issue.message}`)
      .join("；");
    throw new GroupFileError(`包 group 元数据校验失败（${issues}）`);
  }
  const parsed = result.data;
  if (!parsed.versions.some((version) => version.version === parsed.currentVersion)) {
    throw new GroupFileError(`包 group 元数据校验失败（currentVersion "${parsed.currentVersion}" 不在 versions 中）`);
  }
  return parsed;
}

/**
 * 解析并校验 .hnflow-group 包文本。
 * 校验：JSON 合法、format === "hnflow-group"、formatVersion === 1、group/files 为对象、
 * files 路径安全且值为字符串、group 元数据过 load.ts schema。
 * 非法抛 GroupFileError（明确中文消息）。
 */
export function parseGroupPackage(text: string): GroupPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GroupFileError(`.hnflow-group 包不是合法 JSON（${describeError(error)}）`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GroupFileError(".hnflow-group 包必须是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== "hnflow-group") {
    throw new GroupFileError(`包格式标识非法：期望 "hnflow-group"，实际为 ${JSON.stringify(record.format)}`);
  }
  if (record.formatVersion !== 1) {
    throw new GroupFileError(`包格式版本不匹配：期望 1，实际为 ${JSON.stringify(record.formatVersion)}`);
  }
  if (typeof record.exportedAt !== "string" || record.exportedAt === "") {
    throw new GroupFileError("包 exportedAt 字段必须为非空字符串（ISO-8601 导出时间）");
  }
  if (typeof record.group !== "object" || record.group === null || Array.isArray(record.group)) {
    throw new GroupFileError("包 group 字段必须为对象（CapabilityGroup 元数据）");
  }
  if (typeof record.files !== "object" || record.files === null || Array.isArray(record.files)) {
    throw new GroupFileError("包 files 字段必须为对象（路径 → base64 内容映射）");
  }
  const files: Record<string, string> = {};
  const filesRecord = record.files as Record<string, unknown>;
  for (const [relPath, value] of Object.entries(filesRecord)) {
    assertSafePackagePath(relPath);
    if (typeof value !== "string") {
      throw new GroupFileError(`包文件 "${relPath}" 内容必须为 base64 字符串`);
    }
    files[relPath] = value;
  }
  return {
    format: "hnflow-group",
    formatVersion: 1,
    exportedAt: record.exportedAt,
    group: validateGroupMetadata(record.group),
    files,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 导入前冲突检测（参照 init.ts assertNoConflicts 思路）：GUID 重复 / namespace 占用 / 目标目录已存在均拒绝。 */
async function assertNoImportConflicts(rootDir: string, group: CapabilityGroup): Promise<void> {
  const existing = await scanGroups(rootDir);
  if (existing.some((candidate) => candidate.guid === group.guid)) {
    throw new GroupFileError(`GUID 冲突：${group.guid} 已存在，禁止覆盖导入（GUID 不变性约束）`);
  }
  if (existing.some((candidate) => candidate.namespace === group.namespace)) {
    throw new GroupFileError(`功能组已存在：namespace "${group.namespace}" 已被占用`);
  }
  const targetDir = join(rootDir, ...group.namespace.split("/"));
  if (await isDirectory(targetDir)) {
    throw new GroupFileError(`功能组已存在：目录 "${targetDir}" 已被占用`);
  }
}

/** 收集 content 声明的全部资源路径（加 v<version>/ 前缀，与包 files key 对齐）。 */
function declaredContentPaths(group: CapabilityGroup): string[] {
  const paths: string[] = [];
  for (const version of group.versions) {
    const prefix = `v${version.version}/`;
    const content = version.content;
    if (content.agent !== undefined) paths.push(`${prefix}${content.agent}`);
    for (const tool of content.tools) paths.push(`${prefix}${tool}`);
    for (const mcp of content.mcps) paths.push(`${prefix}${mcp}`);
    for (const rule of content.rules) paths.push(`${prefix}${rule.path}`);
  }
  return paths;
}

/** files 完整性：content 声明的资源必须在 files 中（缺失报错）；多余文件宽容照写。 */
function assertContentCovered(group: CapabilityGroup, files: Readonly<Record<string, string>>): void {
  for (const path of declaredContentPaths(group)) {
    if (!(path in files)) {
      throw new GroupFileError(`包文件缺失：content 声明的 "${path}" 未在包 files 中找到`);
    }
  }
}

/** 写版本目录：先建各 v<version>/ 目录，再解码 base64 写内容文件（路径已安全校验，二次防御）。 */
async function writeContentFiles(
  groupDir: string,
  group: CapabilityGroup,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const version of group.versions) {
    await mkdir(join(groupDir, `v${version.version}`), { recursive: true });
  }
  for (const [relPath, base64] of Object.entries(files)) {
    const safePath = assertSafePackagePath(relPath);
    const absolute = join(groupDir, ...safePath.split("/"));
    const content = Buffer.from(base64, "base64").toString("utf8");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

/**
 * 导入 .hnflow-group 包：元数据校验 → namespace 校验（防 ".." 段逃逸）→ 冲突检测 →
 * 写盘还原（版本目录 + 内容文件 + 原子 group.json）。返回还原后的 CapabilityGroup。
 * 任一校验失败抛 GroupFileError（明确中文消息）。
 */
export async function unpackGroupPackage(rootDir: string, pkg: GroupPackage): Promise<CapabilityGroup> {
  const group = validateGroupMetadata(pkg.group);
  const namespace = validateNamespace(group.namespace); // schema 仅校验非空，此处补路径安全
  const groupDir = join(rootDir, ...namespace.split("/"));

  if (await isDirectory(rootDir)) {
    await assertNoImportConflicts(rootDir, group);
  }

  assertContentCovered(group, pkg.files);
  await writeContentFiles(groupDir, group, pkg.files);
  await atomicWriteFile(join(groupDir, "group.json"), `${JSON.stringify(group, null, 2)}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
  return group;
}
