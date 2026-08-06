// 模板库纯逻辑（T4/T5）：种子初始化、列表、版本加载、发布，与 handlers.ts 分离（无 electron 依赖，可独立验证）。
// 目录结构：templates/<name>/template.json + v<version>/workflow.json（与核心库 src/templates 约定一致）。
// 错误翻译：核心库 TemplateFileError/TemplateNotFoundError/SemanticVersionError 消息已中文，透传；
// errno 类错误经 friendlyWorkflowError 转「文件操作失败」。

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromJSON, toJSON } from "../../../../src/serialization/index.js";
import { TemplateFileError, TemplateNotFoundError } from "../../../../src/templates/errors.js";
import { findTemplateByName, loadTemplateVersion, scanTemplates } from "../../../../src/templates/load.js";
import { releaseTemplateFromWorkflow } from "../../../../src/templates/release-from-workflow.js";
import type { WorkflowTemplate } from "../../../../src/templates/types.js";
import type {
  LoadTemplateVersionPayload,
  LoadTemplateVersionResponse,
  ReleaseTemplatePayload,
  ReleaseTemplateResponse,
  TemplateSummary,
} from "../shared/ipc.js";
import { SEED_TEMPLATES, type SeedTemplate } from "./seed-templates.js";
import { friendlyWorkflowError } from "./workflow-io.js";

/** 模板库根目录名（位于 userData 下）。 */
export const TEMPLATE_LIB_DIR = "templates";

/** 提取 fs 错误码（ENOENT/EACCES 等）；非 fs 错误返回 undefined。 */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

/** 写单个种子模板：先写各版本 v<version>/workflow.json（内容快照），再写 template.json（元数据）。 */
async function writeSeedTemplate(root: string, seed: SeedTemplate): Promise<void> {
  const templateDir = join(root, seed.name);
  await mkdir(templateDir, { recursive: true });
  for (const version of seed.versions) {
    const workflow = seed.versionsWorkflows[version.version];
    if (workflow === undefined) {
      throw new Error(`种子模板 "${seed.name}" 缺少版本 ${version.version} 的 workflow 内容`);
    }
    const versionDir = join(templateDir, `v${version.version}`);
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, "workflow.json"), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  }
  const templateJson = {
    name: seed.name,
    description: seed.description,
    versions: seed.versions,
    currentVersion: seed.currentVersion,
    interface: seed.interface,
  };
  await writeFile(join(templateDir, "template.json"), `${JSON.stringify(templateJson, null, 2)}\n`, "utf8");
}

/** 确保模板库存在：目录缺失或为空 → 创建并写入种子模板；非空 → 跳过。失败抛错（main 启动时 catch 告警）。 */
export async function ensureTemplateLibrary(userDataDir: string): Promise<void> {
  const root = join(userDataDir, TEMPLATE_LIB_DIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error; // 目录存在但不可读等错误直接上抛
    entries = []; // 目录不存在 → 视为空库，继续初始化
  }
  if (entries.length > 0) return; // 已有模板 → 跳过种子写入（不覆盖用户数据）
  await mkdir(root, { recursive: true });
  for (const seed of SEED_TEMPLATES) {
    await writeSeedTemplate(root, seed);
  }
}

/** 核心 WorkflowTemplate → IPC TemplateSummary（显式重建，保持 IPC 边界无核心类型引用）。 */
function toTemplateSummary(template: WorkflowTemplate): TemplateSummary {
  return {
    name: template.name,
    description: template.description,
    currentVersion: template.currentVersion,
    versions: template.versions,
    interface: template.interface,
  };
}

/** 列出全部模板（scanTemplates 包装；模板根目录缺失抛 TemplateScanError）。 */
export async function listTemplates(templatesRootDir: string): Promise<readonly TemplateSummary[]> {
  const templates = await scanTemplates(templatesRootDir);
  return templates.map(toTemplateSummary);
}

/** 加载指定版本 workflow（模板不存在抛 TemplateNotFoundError；版本不在 versions 抛 TemplateFileError）。 */
export async function loadTemplateVersionPayload(
  templatesRootDir: string,
  payload: LoadTemplateVersionPayload,
): Promise<LoadTemplateVersionResponse> {
  const template = await findTemplateByName(templatesRootDir, payload.name);
  if (template === undefined) {
    throw new TemplateNotFoundError(`模板不存在：${payload.name}`);
  }
  const templateDir = join(templatesRootDir, template.name);
  const version = payload.version ?? template.currentVersion;
  const workflow = await loadTemplateVersion(templateDir, template, version);
  if (workflow === undefined) {
    throw new TemplateFileError(`版本不存在：${template.name}@${version}（不在模板 versions 中）`);
  }
  return { name: template.name, version, workflow: toJSON(workflow) };
}

/** 发布新版本（releaseTemplateFromWorkflow 包装：payload 先经 fromJSON 校验，错误中文翻译）。 */
export async function releaseTemplateFromPayload(
  templatesRootDir: string,
  payload: ReleaseTemplatePayload,
): Promise<ReleaseTemplateResponse> {
  try {
    const template = await releaseTemplateFromWorkflow(
      templatesRootDir,
      payload.name,
      payload.newVersion,
      fromJSON(payload.workflow),
      payload.changelog,
    );
    return toTemplateSummary(template);
  } catch (error) {
    throw friendlyWorkflowError(error);
  }
}
