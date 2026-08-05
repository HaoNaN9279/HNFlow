// 模板版本通知（T4）：遍历工作流全部节点（含 subworkflow 递归）收集模板引用，对比 currentVersion 输出可升级列表。
// 纯函数：仅读取 template.json，不写文件。upgrade.ts 将复用本报告驱动引用升级。
// 参照 src/groups/updates.ts（checkGroupUpdates）模式：防御跳过 + ignores 精确匹配。
import { scanTemplates } from "./load.js";
import { compareSemVer, parseSemVer } from "../groups/semver.js";
import type { WorkflowTemplate } from "./types.js";
import type { Node, Workflow } from "../model/types.js";

/** 版本差异分类。 */
export type VersionDiff = "major" | "minor" | "patch";

/** 单个模板的升级提示。 */
export interface TemplateUpdateEntry {
  readonly name: string;
  readonly nodePath: string; // 节点路径（含父链），如 "sub1 (子工作流)" 或 "父 → sub2"
  readonly lockedVersion: string;
  readonly latestVersion: string;
  readonly diff: VersionDiff; // latest vs locked 的差异分类
}

/** 版本通知报告。 */
export interface TemplateUpdatesReport {
  readonly entries: readonly TemplateUpdateEntry[];
  readonly ignoredCount: number;
}

export interface CheckTemplateUpdatesOptions {
  /** 忽略列表："name@version" 字符串数组；忽略匹配 lockedVersion（锁定版本）的项，不进入 entries。 */
  readonly ignores?: readonly string[];
}

/** 单个模板引用：锁定版本 + 节点路径 + 节点引用（upgrade.ts 端口校验复用）。 */
export interface TemplateRef {
  readonly name: string;
  readonly version: string; // 锁定版本
  readonly path: string; // 节点路径（含父链）
  readonly node: Node; // 引用节点（端口校验基准）
}

/** 解析模板引用 "name@version"；无 "@"、名称或版本段为空时返回 undefined（防御跳过）。 */
function parseTemplateRef(entry: string): { name: string; version: string } | undefined {
  const at = entry.lastIndexOf("@");
  if (at <= 0 || at === entry.length - 1) return undefined;
  return { name: entry.slice(0, at), version: entry.slice(at + 1) };
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
 * 遍历工作流全部节点（含 node.subworkflow 递归嵌套，参照 collectDeclarations 栈遍历）收集模板引用。
 * 节点路径从遍历栈记录：顶层 "id (name)"，嵌套 "父路径 → id (name)"。
 * params["template"] 非字符串或引用格式非法：跳过（防御）。
 */
export function collectTemplateRefs(workflow: Workflow): TemplateRef[] {
  const refs: TemplateRef[] = [];
  const stack: Array<{ wf: Workflow; parent: string | undefined }> = [{ wf: workflow, parent: undefined }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    for (const node of entry.wf.nodes) {
      const path =
        entry.parent === undefined ? `${node.id} (${node.name})` : `${entry.parent} → ${node.id} (${node.name})`;
      const raw = node.params["template"];
      if (typeof raw === "string") {
        const parsed = parseTemplateRef(raw);
        if (parsed !== undefined) {
          refs.push({ name: parsed.name, version: parsed.version, path, node });
        }
      }
      if (node.subworkflow !== undefined) {
        stack.push({ wf: node.subworkflow, parent: path });
      }
    }
  }
  return refs;
}

/**
 * 对比工作流模板引用与当前版本，输出可升级列表。
 * - 无 template 引用 → 空报告；
 * - 引用无效 / 模板不存在：防御跳过，不抛错（T7 保存校验负责报错）；
 * - 忽略列表精确匹配 "name@lockedVersion"：跳过并计入 ignoredCount；
 * - latest <= locked：跳过。
 */
export async function checkTemplateUpdates(
  rootDir: string,
  workflow: Workflow,
  options?: CheckTemplateUpdatesOptions,
): Promise<TemplateUpdatesReport> {
  const refs = collectTemplateRefs(workflow);
  if (refs.length === 0) {
    return { entries: [], ignoredCount: 0 };
  }

  const templates = await scanTemplates(rootDir);
  const byName = new Map<string, WorkflowTemplate>(templates.map((template) => [template.name, template]));
  const ignores = new Set(options?.ignores ?? []);

  const entries: TemplateUpdateEntry[] = [];
  let ignoredCount = 0;

  for (const ref of refs) {
    const template = byName.get(ref.name);
    if (template === undefined) continue; // 模板不存在：跳过（T7 保存校验负责报错）

    const lockedVersion = ref.version;
    // 忽略过滤：精确匹配 "name@lockedVersion"。
    const ignoreKey = `${ref.name}@${lockedVersion}`;
    if (ignores.has(ignoreKey)) {
      ignoredCount += 1;
      continue;
    }

    const latestVersion = template.currentVersion;
    if (compareSemVer(parseSemVer(latestVersion), parseSemVer(lockedVersion)) <= 0) continue;

    entries.push({
      name: ref.name,
      nodePath: ref.path,
      lockedVersion,
      latestVersion,
      diff: classifyDiff(latestVersion, lockedVersion),
    });
  }

  return { entries, ignoredCount };
}
