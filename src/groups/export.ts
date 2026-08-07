// 功能组导出（v0.9.1 T3）：将功能组（含全部版本历史）打包为 .hnflow-group 单文件 JSON。
// 包格式契约（plan.md 定稿）：format=hnflow-group + formatVersion=1 + exportedAt + group（完整元数据，原样）+ files（v<version>/ 前缀相对路径 → base64）。
// 零新依赖：files 用 Buffer base64 编码；写入复用 storage/atomic.ts 原子写。
// 版本目录缺失：跳过该版本（content 空），不抛错——配合种子组等 group.json 声明了版本但目录未落盘的场景。
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
import { GroupFileError } from "./errors.js";
import { findGroup } from "./load.js";
import type { CapabilityGroup } from "./types.js";

/** 包内单文件条目：path 为包内相对路径（posix 分隔符，v<version>/ 前缀），content 为原始 utf8 内容。 */
export interface GroupPackageFile {
  readonly path: string;
  readonly content: string;
}

/** .hnflow-group 单文件包：格式标识 + 格式版本 + 导出时间 + 完整元数据 + 内容文件（路径 → base64）。 */
export interface GroupPackage {
  readonly format: "hnflow-group"; // 固定标识
  readonly formatVersion: 1;       // 格式版本
  readonly exportedAt: string;     // ISO-8601 导出时间
  readonly group: CapabilityGroup; // 完整元数据，原样透传
  readonly files: { readonly [path: string]: string }; // v<version>/ 前缀相对路径 → base64
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 相对路径转 posix 分隔符：包内路径统一 "/"（Windows 下 relative 返回反斜杠）。 */
function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * 递归遍历版本目录收集全部文件。
 * 返回相对版本目录的路径（posix 分隔符）+ utf8 内容，按路径字典序排序（输出确定）。
 * 目录缺失（ENOENT）跳过该目录：版本目录整体缺失时返回空数组，不抛错。
 */
export async function collectVersionFiles(versionDir: string): Promise<readonly GroupPackageFile[]> {
  const files: GroupPackageFile[] = [];
  await walkVersionDir(versionDir, versionDir, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** 递归收集子目录文件；目录缺失（ENOENT）跳过，读取失败抛 GroupFileError（含具体路径）。 */
async function walkVersionDir(base: string, dir: string, files: GroupPackageFile[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return; // 目录缺失：跳过
    }
    throw new GroupFileError(`读取版本目录失败：${dir}（${describeError(error)}）`);
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkVersionDir(base, abs, files);
    } else if (entry.isFile()) {
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch (error) {
        throw new GroupFileError(`读取版本文件失败：${abs}（${describeError(error)}）`);
      }
      files.push({ path: toPosixPath(relative(base, abs)), content });
    }
  }
}

/**
 * 组装包对象：format/formatVersion/exportedAt + group（原样）+ files（path → base64）。
 * files 中重复 path 后者覆盖前者（collectVersionFiles 已保证版本内唯一，多版本前缀不同）。
 */
export function buildGroupPackage(group: CapabilityGroup, files: readonly GroupPackageFile[]): GroupPackage {
  const encodedFiles: Record<string, string> = {};
  for (const file of files) {
    encodedFiles[file.path] = Buffer.from(file.content, "utf8").toString("base64");
  }
  return {
    format: "hnflow-group",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    group,
    files: encodedFiles,
  };
}

/**
 * 导出入口：按 namespace（含 aliases）定位功能组 → 遍历 group.versions 收集各版本内容文件 →
 * 组装包对象 → 原子写 destFile（tmp → 读回校验 → rename）→ 返回包对象。
 * 功能组不存在抛 GroupFileError；版本目录缺失跳过（不抛错）。
 */
export async function exportGroupPackage(
  rootDir: string,
  namespace: string,
  destFile: string,
): Promise<GroupPackage> {
  const group = await findGroup(rootDir, namespace);
  if (group === undefined) {
    throw new GroupFileError(`功能组不存在：${namespace}`);
  }
  const groupDir = join(rootDir, ...group.namespace.split("/"));
  const files: GroupPackageFile[] = [];
  for (const version of group.versions) {
    const versionFiles = await collectVersionFiles(join(groupDir, `v${version.version}`));
    for (const file of versionFiles) {
      files.push({ path: `v${version.version}/${file.path}`, content: file.content });
    }
  }
  const pkg = buildGroupPackage(group, files);
  await atomicWriteFile(destFile, `${JSON.stringify(pkg, null, 2)}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
  return pkg;
}
