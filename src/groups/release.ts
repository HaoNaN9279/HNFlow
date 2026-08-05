// 功能组版本发布（v0.3.0 T2）：语义版本递增校验 + 不可变快照拷贝 + 资源清单收集与查重 + group.json 更新。
// 生命周期对齐设计文档 §3.2.5「修改」：修改=创建新版本（不可变），版本号递增，编写 changelog。
// 发布不做内容语义加载（T3 范围）：新版本目录 = 上一版本目录整体拷贝（不可变快照继承语义）。
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
import { GroupFileError } from "./errors.js";
import { agentPlaceholder, validateNamespace } from "./init.js";
import { loadGroup, loadVersion } from "./load.js";
import { compareSemVer, parseSemVer } from "./semver.js";
import type { CapabilityGroup, GroupContent, GroupVersion, ResourceEntry, RuleEntry } from "./types.js";

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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 资源名 = 文件名去扩展名：rules/01-build.md 与 rules/01-build.txt 视为同名规则（唯一性域 type+name，§3.2.3）。 */
function resourceName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** 列出目录下顶层文件并按文件名排序（rules 的 order 由排序隐含，01- 前缀自然序）。目录不存在返回空数组。 */
async function listTopLevelFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** 尽力清理目录：发布失败时移除半成品版本目录，清理失败不掩盖原始错误。 */
async function removeDirQuietly(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // no-excuse-ok: catch — 清理失败不影响原始错误的抛出
  }
}

/**
 * 扫描版本目录生成资源登记项（供 T3 索引注册复用）：
 * agent → 单文件 agent.md；mcp → mcp.json；tools/ 顶层文件；rules/ 顶层文件（按文件名排序，顺序即 order）。
 * 路径统一 posix 风格（相对版本目录）。
 */
export async function collectResources(versionDir: string): Promise<ResourceEntry[]> {
  let rootEntries;
  try {
    rootEntries = await readdir(versionDir, { withFileTypes: true });
  } catch (error) {
    throw new GroupFileError(`读取版本目录失败：${versionDir}（${describeError(error)}）`);
  }
  const resources: ResourceEntry[] = [];
  const rootNames = new Set(rootEntries.map((entry) => entry.name));

  if (rootNames.has("agent.md")) {
    resources.push({ type: "agent", name: "agent", path: "agent.md" });
  }
  if (rootNames.has("mcp.json")) {
    resources.push({ type: "mcp", name: "mcp", path: "mcp.json" });
  }

  for (const fileName of await listTopLevelFiles(join(versionDir, "tools"))) {
    resources.push({ type: "tool", name: resourceName(fileName), path: `tools/${fileName}` });
  }
  for (const fileName of await listTopLevelFiles(join(versionDir, "rules"))) {
    resources.push({ type: "rule", name: resourceName(fileName), path: `rules/${fileName}` });
  }
  return resources;
}

/** 版本内资源查重：同 (type, name) 重复拒绝发布；跨类型同名不冲突（resource_registry 按 type 区分）。 */
function assertNoDuplicateResources(resources: ResourceEntry[]): void {
  const seen = new Set<string>();
  for (const resource of resources) {
    const key = `${resource.type}:${resource.name}`;
    if (seen.has(key)) {
      throw new GroupFileError(
        `版本资源重复：${resource.type} 类型下存在多个同名资源 "${resource.name}"（同类型资源名在版本内必须唯一）`,
      );
    }
    seen.add(key);
  }
}

/**
 * 发布新版本：
 * 1. 加载现有组（不存在抛 GroupFileError）；
 * 2. 校验 newVersion 合法且递增（compareSemVer > currentVersion，否则抛错含当前版本）；
 * 3. 同版本已在 versions / 版本目录已存在 → 拒绝（版本目录不可变）；
 * 4. 上一版本目录整体拷贝到新版本目录（空则建目录 + agent.md 模板）；
 * 5. 扫描新版本目录资源并查重，重复 → 清理半成品并拒绝；
 * 6. 生成新 GroupVersion（content 扫描生成，requiresCoreVersion/dependencies 继承上一版本）；
 * 7. 原子更新 group.json（versions 追加 + currentVersion）。
 */
export async function releaseGroup(
  rootDir: string,
  namespace: string,
  newVersion: string,
  changelog?: string,
): Promise<CapabilityGroup> {
  const normalized = validateNamespace(namespace);
  const parsedNew = parseSemVer(newVersion); // 非法版本号抛 SemanticVersionError

  const groupDir = join(rootDir, ...normalized.split("/"));
  if (!(await isDirectory(groupDir))) {
    throw new GroupFileError(`功能组不存在：${normalized}（${groupDir}）`);
  }
  const group = await loadGroup(groupDir);

  const currentVersion = group.currentVersion;
  if (compareSemVer(parsedNew, parseSemVer(currentVersion)) <= 0) {
    throw new GroupFileError(`版本必须递增：新版本 "${newVersion}" 需大于当前版本 "${currentVersion}"`);
  }
  if (loadVersion(group, newVersion) !== undefined) {
    throw new GroupFileError(`版本已存在：${newVersion} 已在 versions 中（版本目录不可变）`);
  }
  const newVersionDir = join(groupDir, `v${newVersion}`);
  if (await isDirectory(newVersionDir)) {
    throw new GroupFileError(`版本目录已存在（不可变）：${newVersionDir}`);
  }

  // 不可变快照继承：新版本目录 = 上一版本目录整体拷贝；无上一版本目录（或为空）则建目录 + agent.md 模板。
  const prevVersionDir = join(groupDir, `v${currentVersion}`);
  if (await isDirectory(prevVersionDir)) {
    await cp(prevVersionDir, newVersionDir, { recursive: true });
  } else {
    await mkdir(newVersionDir, { recursive: true });
  }
  const newAgentPath = join(newVersionDir, "agent.md");
  if (!(await pathExists(newAgentPath))) {
    await writeFile(newAgentPath, agentPlaceholder(normalized), "utf8");
  }

  let resources: ResourceEntry[];
  try {
    resources = await collectResources(newVersionDir);
    assertNoDuplicateResources(resources);
  } catch (error) {
    await removeDirQuietly(newVersionDir);
    throw error;
  }

  const prevContent = loadVersion(group, currentVersion)?.content;
  const agentResource = resources.find((resource) => resource.type === "agent");
  const ruleEntries: RuleEntry[] = resources
    .filter((resource): resource is ResourceEntry & { type: "rule" } => resource.type === "rule")
    .map((resource, index) => ({ path: resource.path, order: index + 1 }));

  const content: GroupContent = {
    tools: resources.filter((resource) => resource.type === "tool").map((resource) => resource.path),
    mcps: resources.filter((resource) => resource.type === "mcp").map((resource) => resource.path),
    rules: ruleEntries,
    ...(agentResource !== undefined ? { agent: agentResource.path } : {}),
    ...(prevContent?.requiresCoreVersion !== undefined ? { requiresCoreVersion: prevContent.requiresCoreVersion } : {}),
    ...(prevContent?.dependencies !== undefined ? { dependencies: prevContent.dependencies } : {}),
  };

  const releasedVersion: GroupVersion = {
    version: newVersion,
    createdAt: new Date().toISOString(),
    changelog: changelog ?? "更新",
    content,
  };

  const updatedGroup: CapabilityGroup = {
    ...group,
    versions: [...group.versions, releasedVersion],
    currentVersion: newVersion,
  };
  await atomicWriteFile(join(groupDir, "group.json"), `${JSON.stringify(updatedGroup, null, 2)}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
  return updatedGroup;
}
