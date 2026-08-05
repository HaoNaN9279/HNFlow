// 功能组创建（v0.3.0 T2）：生成 GUID + namespace 目录 + 初始版本 v0.1.0 模板。
// 生命周期对齐设计文档 §3.2.5「创建」：创建=新 GUID + 命名空间文件夹 + v0.1 初始版本。
// namespace 冲突 / 校验失败 / GUID 碰撞均抛 GroupFileError（明确中文消息）。
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
import { GroupFileError } from "./errors.js";
import { scanGroups } from "./load.js";
import type { CapabilityGroup } from "./types.js";

/** 初始版本号：功能组创建时生成 v0.1.0。 */
export const INITIAL_VERSION = "0.1.0";

/** Windows 路径非法字符：namespace 段内禁止（除 "/" 外，段内也不允许 "\"）。 */
const WINDOWS_INVALID_PATH_CHARS = /[\\:*?"<>|]/;

/**
 * 校验并规范化 namespace（posix 风格，"/" 分隔）。
 * 规则：非空；禁前导/尾随 "/"；禁空段（"//"）；禁 "." 与 ".." 段；禁 Windows 路径非法字符；禁空白字符。
 * 校验通过返回原值（已规范，无需转换）。
 */
export function validateNamespace(namespace: string): string {
  if (namespace === "") {
    throw new GroupFileError("namespace 不能为空");
  }
  if (namespace.startsWith("/") || namespace.endsWith("/")) {
    throw new GroupFileError(`namespace "${namespace}" 非法：不能以 "/" 开头或结尾`);
  }
  if (WINDOWS_INVALID_PATH_CHARS.test(namespace)) {
    throw new GroupFileError(`namespace "${namespace}" 非法：不能包含 Windows 路径非法字符（\\ : * ? " < > |）`);
  }
  const segments = namespace.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new GroupFileError(`namespace "${namespace}" 非法：路径段不能为空、"." 或 ".."`);
    }
    if (/\s/.test(segment)) {
      throw new GroupFileError(`namespace "${namespace}" 非法：路径段不能包含空白字符`);
    }
  }
  return namespace;
}

/** agent.md 占位模板：创建与空版本目录补写共用（身份定义见设计文档 §7.1）。 */
export function agentPlaceholder(namespace: string): string {
  return [
    "# Agent 身份定义（占位）",
    "",
    `- namespace: ${namespace}`,
    "- 此文件定义功能组在 AI 运行时注入的 Agent 身份（systemMessage 源）。",
    "- 发布新版本前编辑本文件与 rules/、tools/ 内容。",
    "",
  ].join("\n");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 创建前冲突检测：GUID 重复（极端碰撞）、namespace 已存在、目标目录已占用（无 group.json 也拒绝覆盖）。 */
async function assertNoConflicts(rootDir: string, namespace: string, guid: string): Promise<void> {
  const existing = await scanGroups(rootDir);
  if (existing.some((group) => group.guid === guid)) {
    throw new GroupFileError(`GUID 冲突：${guid} 已被占用（随机 ID 碰撞，请重试）`);
  }
  if (existing.some((group) => group.namespace === namespace)) {
    throw new GroupFileError(`功能组已存在：namespace "${namespace}" 已被占用`);
  }
  const targetDir = join(rootDir, ...namespace.split("/"));
  if (await isDirectory(targetDir)) {
    throw new GroupFileError(`功能组已存在：目录 "${targetDir}" 已被占用`);
  }
}

/**
 * 创建功能组：校验 namespace → 冲突检测 → 生成 GUID → 建目录结构（group.json + v0.1.0/agent.md + rules/ + tools/）。
 * group.json 原子写（tmp → 读回校验 → rename），namespace 存 posix 格式。
 */
export async function initGroup(rootDir: string, namespace: string): Promise<CapabilityGroup> {
  const normalized = validateNamespace(namespace);
  const guid = randomUUID();

  if (await isDirectory(rootDir)) {
    await assertNoConflicts(rootDir, normalized, guid);
  }

  const groupDir = join(rootDir, ...normalized.split("/"));
  const versionDir = join(groupDir, `v${INITIAL_VERSION}`);
  await mkdir(join(versionDir, "rules"), { recursive: true });
  await mkdir(join(versionDir, "tools"), { recursive: true });
  await writeFile(join(versionDir, "agent.md"), agentPlaceholder(normalized), "utf8");

  const group: CapabilityGroup = {
    guid,
    namespace: normalized,
    aliases: [],
    description: "",
    versions: [
      {
        version: INITIAL_VERSION,
        createdAt: new Date().toISOString(),
        changelog: "初始版本",
        content: { tools: [], mcps: [], rules: [] },
      },
    ],
    currentVersion: INITIAL_VERSION,
  };
  await atomicWriteFile(join(groupDir, "group.json"), `${JSON.stringify(group, null, 2)}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
  return group;
}
