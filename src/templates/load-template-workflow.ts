// 子工作流模板引用解析与加载（T2）：subworkflow 节点 params.template（"name@version"）→ 定位模板 → 加载版本工作流。
// 目录结构：templates/<name>/template.json + v<version>/workflow.json；错误消息一律含引用值（"name@version"）与原因。
import { join } from "node:path";
import type { Workflow } from "../model/types.js";
import { TemplateNotFoundError } from "./errors.js";
import { findTemplateByName, loadTemplateVersion } from "./load.js";

/**
 * 解析模板引用 "name@version"：lastIndexOf("@") 切分，最后一个 @ 之后为版本号。
 * 无 "@" 或 @ 在开头/结尾（name/version 任一段为空）→ undefined（非法引用）。
 */
export function parseTemplateRef(
  ref: string,
): { readonly name: string; readonly version: string } | undefined {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1) return undefined;
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

/**
 * 按引用加载模板工作流：解析引用（非法抛 TemplateNotFoundError 含引用值）→
 * 查模板（不存在抛 TemplateNotFoundError 含引用值）→ 加载版本
 * （版本不存在抛 TemplateNotFoundError 含引用值与可用版本列表）。
 * workflow.json 读取/解析/校验失败由 loadTemplateVersion 抛 TemplateFileError。
 */
export async function loadTemplateWorkflow(templatesRootDir: string, ref: string): Promise<Workflow> {
  const parsed = parseTemplateRef(ref);
  if (parsed === undefined) {
    throw new TemplateNotFoundError(`无效模板引用 "${ref}"：应为 "name@version" 格式`);
  }
  const template = await findTemplateByName(templatesRootDir, parsed.name);
  if (template === undefined) {
    throw new TemplateNotFoundError(
      `模板 "${parsed.name}@${parsed.version}" 不存在：模板库 "${templatesRootDir}" 中未找到 "${parsed.name}"`,
    );
  }
  const workflow = await loadTemplateVersion(join(templatesRootDir, parsed.name), template, parsed.version);
  if (workflow === undefined) {
    const available = template.versions.map((candidate) => candidate.version).join(", ");
    throw new TemplateNotFoundError(
      `模板 "${parsed.name}@${parsed.version}" 版本不存在：可用版本 ${available}`,
    );
  }
  return workflow;
}
