// 子工作流模板版本发布（v0.3.3 T5）：语义版本递增校验 + 不可变快照拷贝 + interface.inputs 重算 + template.json 更新。
// 生命周期对齐设计文档 §4.2「版本化管理」：修改=创建新版本（不可变），版本号递增，编写 changelog。
// 模板目录结构：templates/<name>/template.json（元数据）+ v<version>/workflow.json（内容快照，不可变）。
// 发布不做内容语义加载（T6 范围）：新版本目录 = 上一版本目录整体拷贝（不可变快照继承语义），
// interface.inputs 从新版本 workflow.json 的 workflow:params binding 重算，interface.outputs 沿用当前模板值。
import { cp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { compareSemVer, parseSemVer } from "../groups/semver.js";
import { atomicWriteFile } from "../storage/atomic.js";
import { validateTemplateName } from "./create.js";
import { TemplateFileError, TemplateNotFoundError } from "./errors.js";
import { loadTemplate } from "./load.js";
import type { TemplateVersion, WorkflowTemplate } from "./types.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 尽力清理目录：发布失败时移除半成品版本目录，清理失败不掩盖原始错误。 */
async function removeDirQuietly(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // no-excuse-ok: catch — 清理失败不影响原始错误的抛出
  }
}

/** 定位模板目录并确认元数据存在；模板目录 / template.json 缺失抛 TemplateNotFoundError。 */
async function locateTemplate(rootDir: string, name: string): Promise<string> {
  const templateDir = join(rootDir, validateTemplateName(name));
  if (!(await isDirectory(templateDir))) {
    throw new TemplateNotFoundError(`模板不存在：${name}（${templateDir}）`);
  }
  if (!(await isFile(join(templateDir, "template.json")))) {
    throw new TemplateNotFoundError(`模板不存在：${name}（template.json 缺失）`);
  }
  return templateDir;
}

/**
 * 从 workflow.json 收集对外输入参数名：遍历所有节点 inputs 的 binding，
 * 收集以 "workflow:params:" 为前缀的后缀集合（有序去重，按出现顺序）。
 */
async function collectParamKeys(workflowJsonPath: string): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(workflowJsonPath, "utf8");
  } catch (error) {
    throw new TemplateFileError(`读取 workflow.json 失败：${workflowJsonPath}（${describeError(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TemplateFileError(`workflow.json 不是合法 JSON：${workflowJsonPath}（${describeError(error)}）`);
  }
  const candidate = parsed as { nodes?: unknown[] };
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(candidate.nodes)) {
    throw new TemplateFileError(`workflow.json 校验失败：${workflowJsonPath}（缺少 nodes 数组）`);
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const node of candidate.nodes) {
    const inputs = (node as { inputs?: unknown[] }).inputs;
    if (!Array.isArray(inputs)) continue;
    for (const port of inputs) {
      const binding = (port as { binding?: unknown }).binding;
      if (typeof binding !== "string" || !binding.startsWith("workflow:params:")) continue;
      const key = binding.slice("workflow:params:".length);
      if (key !== "" && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * 发布新版本：
 * 1. 校验 newVersion 合法语义版本（非法抛 SemanticVersionError）；
 * 2. 定位并加载现有模板（模板不存在抛 TemplateNotFoundError）；
 * 3. 版本递增校验（<= currentVersion 抛 TemplateFileError 含当前版本）；
 * 4. 同版本已在 versions / 版本目录已存在 → 拒绝（版本目录不可变）；
 * 5. 上一版本目录整体拷贝到新版本目录（缺失抛 TemplateFileError，模板必须至少有一版内容）；
 * 6. interface.inputs 从新版本 workflow.json 重算，interface.outputs 沿用当前模板值；
 * 7. 原子更新 template.json（versions 追加 + currentVersion + interface）。
 */
export async function releaseTemplate(
  rootDir: string,
  name: string,
  newVersion: string,
  changelog?: string,
): Promise<WorkflowTemplate> {
  const parsedNew = parseSemVer(newVersion); // 非法版本号抛 SemanticVersionError
  const templateDir = await locateTemplate(rootDir, name);
  const template = await loadTemplate(templateDir);

  const currentVersion = template.currentVersion;
  if (compareSemVer(parsedNew, parseSemVer(currentVersion)) <= 0) {
    throw new TemplateFileError(`版本必须递增：新版本 "${newVersion}" 需大于当前版本 "${currentVersion}"`);
  }
  if (template.versions.some((version) => version.version === newVersion)) {
    throw new TemplateFileError(`版本已存在：${newVersion} 已在 versions 中（版本目录不可变）`);
  }
  const newVersionDir = join(templateDir, `v${newVersion}`);
  if (await isDirectory(newVersionDir)) {
    throw new TemplateFileError(`版本目录已存在（不可变）：${newVersionDir}`);
  }

  // 不可变快照继承：新版本目录 = 上一版本目录整体拷贝；模板必须至少有一版内容才能发布。
  const prevVersionDir = join(templateDir, `v${currentVersion}`);
  if (!(await isDirectory(prevVersionDir))) {
    throw new TemplateFileError(`上一版本目录不存在：${prevVersionDir}（模板必须至少有一版内容才能发布）`);
  }
  await cp(prevVersionDir, newVersionDir, { recursive: true });

  // interface.inputs 重算（从新版本 workflow.json），outputs 沿用当前模板值。
  let inputs: readonly string[];
  try {
    inputs = await collectParamKeys(join(newVersionDir, "workflow.json"));
  } catch (error) {
    await removeDirQuietly(newVersionDir);
    throw error;
  }
  const outputs = template.interface.outputs;

  const releasedVersion: TemplateVersion = {
    version: newVersion,
    createdAt: new Date().toISOString(),
    changelog: changelog ?? "更新",
  };

  const updatedTemplate: WorkflowTemplate = {
    ...template,
    versions: [...template.versions, releasedVersion],
    currentVersion: newVersion,
    interface: { inputs, outputs },
  };
  await atomicWriteFile(join(templateDir, "template.json"), `${JSON.stringify(updatedTemplate, null, 2)}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
  return updatedTemplate;
}
