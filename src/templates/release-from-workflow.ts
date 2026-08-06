// 模板发布新内容（v0.3.3 T6）：从编辑后的工作流内容发布新版本，区别于 releaseTemplate 的目录拷贝继承。
// 生命周期对齐设计文档 §4.2「版本化管理」：修改=创建新版本（不可变），内容直接写新版本快照（非拷贝）。
// 校验规则与 releaseTemplate 保持一致：语义版本递增 + 版本/目录不可变 + interface.inputs 重算 + template.json 原子更新。
// 目录结构：templates/<name>/template.json（元数据）+ v<version>/workflow.json（内容快照，不可变）。
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { compareSemVer, parseSemVer } from "../groups/semver.js";
import type { Workflow } from "../model/types.js";
import { serialize } from "../serialization/index.js";
import { atomicWriteFile } from "../storage/atomic.js";
import { validateTemplateName } from "./create.js";
import { TemplateFileError, TemplateNotFoundError } from "./errors.js";
import { loadTemplate } from "./load.js";
import type { TemplateVersion, WorkflowTemplate } from "./types.js";

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

/** 从工作流对象收集对外输入参数名：遍历 nodes 的 inputs binding "workflow:params:" 后缀（有序去重，按出现顺序）。 */
function collectParamKeysFromWorkflow(workflow: Workflow): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    for (const port of node.inputs) {
      if (port.binding === undefined || !port.binding.startsWith("workflow:params:")) continue;
      const key = port.binding.slice("workflow:params:".length);
      if (key !== "" && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/** 原子写辅助：写入后 JSON.parse 完整性校验（惯例同 create.ts writeJson）。 */
async function writeJson(filePath: string, content: string): Promise<void> {
  await atomicWriteFile(filePath, `${content}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
}

/**
 * 从编辑后的工作流内容发布模板新版本：
 * 1. 校验 newVersion 合法语义版本（非法抛 SemanticVersionError）；
 * 2. 定位并加载现有模板（模板不存在抛 TemplateNotFoundError）；
 * 3. 版本递增校验（<= currentVersion 抛 TemplateFileError 含当前版本）；
 * 4. 同版本已在 versions / 版本目录已存在 → 拒绝（版本目录不可变）；
 * 5. 新版本目录创建并直接写入 serialize(workflow)（序列化即 zod 校验；写入失败清理半成品目录）；
 * 6. interface.inputs 从传入 workflow.nodes 的 binding 重算，outputs 沿用当前模板值；
 * 7. 原子更新 template.json（versions 追加 + currentVersion + interface）。
 * 与 releaseTemplate 差异：内容为调用方传入的编辑后工作流（直接写新版本快照），而非上一版本目录拷贝。
 */
export async function releaseTemplateFromWorkflow(
  rootDir: string,
  name: string,
  newVersion: string,
  workflow: Workflow,
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

  // 内容直接写新版本快照（非拷贝）：先建目录（atomicWriteFile 依赖父目录存在语义上仍需显式 mkdir），再原子写 workflow.json。
  await mkdir(newVersionDir, { recursive: true });
  try {
    const content = serialize(workflow); // 序列化即 toJSON zod 校验，非法工作流抛错
    await writeJson(join(newVersionDir, "workflow.json"), content);
  } catch (error) {
    await removeDirQuietly(newVersionDir);
    throw error;
  }

  // interface.inputs 从传入工作流对象重算（不读文件），outputs 沿用当前模板值（与 releaseTemplate 一致）。
  const inputs = collectParamKeysFromWorkflow(workflow);
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
