// 模板引用存在性校验（v0.3.2 T7）：遍历工作流全部节点（含 subworkflow 递归）收集 params["template"] 引用，
// 批量校验模板与版本是否存在，返回错误数组。供保存链路在落盘前拦截缺失引用（不抛错，批量报告）。
// 参照 src/groups/resolve.ts（collectDeclarations）栈遍历模式；updates.ts 的 collectTemplateRefs 跳过非法格式，
// 本模块需要把非法格式也作为错误报告，因此独立遍历。
import { scanTemplates } from "./load.js";
import { TemplateScanError } from "./errors.js";
import type { Workflow } from "../model/types.js";
import type { WorkflowTemplate } from "./types.js";

/** 单个模板引用校验错误。 */
export interface TemplateRefError {
  readonly nodePath: string; // 含父链的节点路径，如 "sub-1 (子工作流)" 或 "父 → sub-2"
  readonly ref: string; // 引用原文 "name@version"
  readonly reason: string; // 引用格式非法 / 模板不存在 / 版本不存在（含可用版本）
}

/**
 * 校验工作流全部模板引用存在性。
 * - 遍历全部节点（含 node.subworkflow 递归，栈遍历），收集 params["template"] 字符串引用；
 * - 无效引用格式（无 "@"、名称或版本段为空）→ reason "引用格式非法"；
 * - 模板不存在 → reason "模板不存在"；
 * - 版本不在 template.versions → reason "版本不存在（可用：x.y.z, ...）"；
 * - 无引用 / 全部有效 → 空数组；不抛错，批量返回错误（模板根目录缺失视为无模板，引用全部报"模板不存在"）。
 */
export async function verifyTemplateRefs(rootDir: string, workflow: Workflow): Promise<TemplateRefError[]> {
  let templates: WorkflowTemplate[];
  try {
    templates = await scanTemplates(rootDir);
  } catch (error) {
    if (error instanceof TemplateScanError) {
      templates = []; // 模板根目录缺失：视为无任何模板，引用全部报"模板不存在"
    } else {
      throw error;
    }
  }
  const byName = new Map<string, WorkflowTemplate>(templates.map((template) => [template.name, template]));

  const errors: TemplateRefError[] = [];
  const stack: Array<{ wf: Workflow; parent: string | undefined }> = [{ wf: workflow, parent: undefined }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    for (const node of entry.wf.nodes) {
      const path =
        entry.parent === undefined ? `${node.id} (${node.name})` : `${entry.parent} → ${node.id} (${node.name})`;
      const raw = node.params["template"];
      if (typeof raw === "string") {
        const at = raw.lastIndexOf("@");
        if (at <= 0 || at === raw.length - 1) {
          errors.push({ nodePath: path, ref: raw, reason: "引用格式非法" });
          continue;
        }
        const name = raw.slice(0, at);
        const version = raw.slice(at + 1);
        const template = byName.get(name);
        if (template === undefined) {
          errors.push({ nodePath: path, ref: raw, reason: "模板不存在" });
        } else if (!template.versions.some((candidate) => candidate.version === version)) {
          const available = template.versions.map((candidate) => candidate.version).join(", ");
          errors.push({ nodePath: path, ref: raw, reason: `版本不存在（可用：${available}）` });
        }
      }
      if (node.subworkflow !== undefined) {
        stack.push({ wf: node.subworkflow, parent: path });
      }
    }
  }
  return errors;
}
