// 模板库加载（T1）：template.json 读取/校验 + templates/ 目录递归扫描 + 版本 workflow.json 加载校验。
// 目录结构：templates/<name>/template.json + v<version>/workflow.json（子工作流打包产物）。
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseSemVer } from "../groups/semver.js";
import type { Workflow } from "../model/types.js";
import { validateWorkflow } from "../model/validate.js";
import { TemplateFileError, TemplateScanError } from "./errors.js";
import type { TemplateInterface, TemplateVersion, WorkflowTemplate } from "./types.js";

// ---- zod schemas：template.json 边界校验，字段与 types.ts 契约对齐（惯例同 src/groups/load.ts）----

const isSemverString = (value: string): boolean => {
  try {
    parseSemVer(value);
    return true;
  } catch {
    return false;
  }
};

const templateVersionSchema: z.ZodType<TemplateVersion> = z.object({
  version: z.string().refine(isSemverString, { message: "版本号必须为严格语义版本号 x.y.z" }),
  createdAt: z.string(),
  changelog: z.string(),
});

const templateInterfaceSchema: z.ZodType<TemplateInterface> = z.object({
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
});

/** template.json 校验 schema：输出即 WorkflowTemplate。interface 必填（zod 默认 strip 未知字段，漏配会让 T4 读不到端口基准）。 */
export const templateJsonSchema: z.ZodType<WorkflowTemplate> = z.object({
  name: z.string().min(1, { message: "name 不能为空" }),
  description: z.string(),
  versions: z.array(templateVersionSchema).min(1, { message: "至少需要一个版本" }),
  currentVersion: z.string().refine(isSemverString, { message: "currentVersion 必须为合法语义版本号 x.y.z" }),
  interface: templateInterfaceSchema,
});

// ---- 加载与扫描 ----

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 加载单个模板定义：读取 dir/template.json 并校验。文件缺失 / JSON 非法 / 校验失败抛 TemplateFileError。 */
export async function loadTemplate(dir: string): Promise<WorkflowTemplate> {
  const filePath = join(dir, "template.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new TemplateFileError(`读取 template.json 失败：${filePath}（${describeError(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TemplateFileError(`template.json 不是合法 JSON：${filePath}（${describeError(error)}）`);
  }
  const result = templateJsonSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(根)"}：${issue.message}`).join("；");
    throw new TemplateFileError(`template.json 校验失败：${filePath}（${issues}）`);
  }
  const template = result.data;
  // currentVersion 必须存在于 versions 中（schema 无法直接跨字段校验，此处二次确认）。
  if (!template.versions.some((version) => version.version === template.currentVersion)) {
    throw new TemplateFileError(
      `template.json 校验失败：${filePath}（currentVersion "${template.currentVersion}" 不在 versions 中）`,
    );
  }
  return template;
}

/**
 * 递归扫描 rootDir 下所有含 template.json 的模板目录（目录深度不限）。
 * 模板名 = template.json 的 name 字段（= 目录名）。
 * - 无 template.json 的分组目录（如 templates/web/）跳过并继续下钻；
 * - 单个 template.json 损坏：console.warn 跳过该模板，不中断整体扫描；
 * - rootDir 不存在 / 不是目录：抛 TemplateScanError。
 * 返回按 name 字典序排序。
 */
export async function scanTemplates(rootDir: string): Promise<WorkflowTemplate[]> {
  let rootInfo;
  try {
    rootInfo = await stat(rootDir);
  } catch {
    throw new TemplateScanError(`模板根目录不存在或不可访问：${rootDir}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new TemplateScanError(`模板根目录不是目录：${rootDir}`);
  }

  const templates: WorkflowTemplate[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.warn(`跳过无法读取的目录 "${dir}"：${describeError(error)}`);
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "template.json")) {
      try {
        templates.push(await loadTemplate(dir));
      } catch (error) {
        // 单个损坏的 template.json 不致命：跳过并警告，保留其他模板。
        console.warn(`跳过损坏的模板目录 "${dir}"：${describeError(error)}`);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
      }
    }
  }

  await walk(rootDir);
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}

/** 按名称查找模板，未命中返回 undefined。 */
export async function findTemplateByName(rootDir: string, name: string): Promise<WorkflowTemplate | undefined> {
  const templates = await scanTemplates(rootDir);
  return templates.find((template) => template.name === name);
}

/**
 * 加载模板指定版本的工作流（子工作流打包产物）。
 * 版本不在 template.versions 中返回 undefined；文件缺失 / JSON 非法 / 形状非法 / 校验失败抛 TemplateFileError。
 * workflow.json 路径 = templateDir/v<version>/workflow.json。
 */
export async function loadTemplateVersion(
  templateDir: string,
  template: WorkflowTemplate,
  version: string,
): Promise<Workflow | undefined> {
  if (!template.versions.some((candidate) => candidate.version === version)) {
    return undefined;
  }
  const filePath = join(templateDir, `v${version}`, "workflow.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new TemplateFileError(`读取 workflow.json 失败：${filePath}（${describeError(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TemplateFileError(`workflow.json 不是合法 JSON：${filePath}（${describeError(error)}）`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TemplateFileError(`workflow.json 校验失败：${filePath}（缺少 nodes/edges 数组）`);
  }
  const candidate = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    throw new TemplateFileError(`workflow.json 校验失败：${filePath}（缺少 nodes/edges 数组）`);
  }
  const workflow = parsed as Workflow;
  const result = validateWorkflow(workflow);
  if (!result.ok) {
    throw new TemplateFileError(`workflow.json 校验失败：${filePath}（${result.errors.join("；")}）`);
  }
  return workflow;
}
