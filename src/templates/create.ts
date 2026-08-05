// 模板创建（T3）：validateTemplateName + createTemplate。
// 结构：templates/<name>/template.json + v0.1.0/workflow.json（packageSubgraph 打包产物）。
// 生命周期对齐 groups/init.ts：创建 = 命名校验 + 冲突检测 + 初始版本 v0.1.0。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Node, Workflow } from "../model/types.js";
import { serialize } from "../serialization/index.js";
import { atomicWriteFile } from "../storage/atomic.js";
import { packageSubgraph } from "../subgraph/package.js";
import { TemplateFileError } from "./errors.js";
import type { TemplateInterface, WorkflowTemplate } from "./types.js";

/** 初始版本号：模板创建时生成 v0.1.0（release 复用）。 */
export const INITIAL_TEMPLATE_VERSION = "0.1.0";

/** Windows 路径非法字符：模板名段内禁止。 */
const WINDOWS_INVALID_PATH_CHARS = /[\\:*?"<>|]/;

/**
 * 校验模板名（posix 风格，"/" 分隔，参照 groups/init.ts validateNamespace）。
 * 规则：非空；禁前导/尾随 "/"；禁空段（"//"）；禁 "." 与 ".." 段；
 * 禁 Windows 路径非法字符；禁空白字符；额外禁止 "@"（引用格式 "name@version" 解析用 lastIndexOf，含 @ 会歧义）。
 * 校验通过返回原值（已规范，无需转换）。
 */
export function validateTemplateName(name: string): string {
  if (name === "") {
    throw new TemplateFileError("模板名不能为空");
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    throw new TemplateFileError(`模板名 "${name}" 非法：不能以 "/" 开头或结尾`);
  }
  if (WINDOWS_INVALID_PATH_CHARS.test(name)) {
    throw new TemplateFileError(`模板名 "${name}" 非法：不能包含 Windows 路径非法字符（\\ : * ? " < > |）`);
  }
  if (name.includes("@")) {
    throw new TemplateFileError(`模板名 "${name}" 非法：不能包含 "@"（引用格式 "name@version" 解析歧义）`);
  }
  const segments = name.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new TemplateFileError(`模板名 "${name}" 非法：路径段不能为空、"." 或 ".."`);
    }
    if (/\s/.test(segment)) {
      throw new TemplateFileError(`模板名 "${name}" 非法：路径段不能包含空白字符`);
    }
  }
  return name;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 创建前冲突检测：模板目录已存在（含 template.json 或任意内容）拒绝覆盖（参照 initGroup assertNoConflicts）。 */
async function assertNoConflicts(rootDir: string, name: string): Promise<void> {
  if (await isDirectory(rootDir)) {
    const targetDir = join(rootDir, name);
    if (await isDirectory(targetDir)) {
      throw new TemplateFileError(`模板已存在：目录 "${targetDir}" 已被占用`);
    }
  }
}

/** 端口 id 去前缀：in_<x> → x、out_<x> → x；无前缀返回原值（防御，自动端口均有前缀）。 */
function stripPortPrefix(portId: string, prefix: string): string {
  return portId.startsWith(prefix) ? portId.slice(prefix.length) : portId;
}

/** 由 subworkflow 节点生成接口：inputs/outputs 去 in_/out_ 前缀，保留顺序（含固定 out）。 */
function templateInterfaceOf(subNode: Node): TemplateInterface {
  return {
    inputs: subNode.inputs.map((port) => stripPortPrefix(port.id, "in_")),
    outputs: subNode.outputs.map((port) => stripPortPrefix(port.id, "out_")),
  };
}

/** 原子写辅助：写入后 JSON.parse 完整性校验。 */
async function writeJson(filePath: string, content: string): Promise<void> {
  await atomicWriteFile(filePath, `${content}\n`, (text: string) => {
    JSON.parse(text); // 完整性校验：可解析即认为写入完整
  });
}

/**
 * 创建模板：校验名 → 冲突检测 → packageSubgraph 打包选中节点 → 写 v0.1.0/workflow.json + template.json（原子写）。
 * workflow.json 是打包产物（含 id/name/version/nodes/edges）；template.json 记录版本历史与接口。
 */
export async function createTemplate(
  rootDir: string,
  name: string,
  workflow: Workflow,
  nodeIds: readonly string[],
  description = "",
): Promise<WorkflowTemplate> {
  const normalized = validateTemplateName(name);
  await assertNoConflicts(rootDir, normalized);

  const packed = packageSubgraph(workflow, nodeIds);
  const subNode = packed.workflow.nodes.find((node) => node.id === packed.subNodeId);
  if (subNode === undefined) {
    throw new TemplateFileError("打包结果缺少 subworkflow 节点");
  }

  const templateDir = join(rootDir, normalized);
  const versionDir = join(templateDir, `v${INITIAL_TEMPLATE_VERSION}`);
  await writeJson(join(versionDir, "workflow.json"), serialize(packed.subWorkflow));

  const template: WorkflowTemplate = {
    name: normalized,
    description,
    versions: [
      {
        version: INITIAL_TEMPLATE_VERSION,
        createdAt: new Date().toISOString(),
        changelog: "初始版本",
      },
    ],
    currentVersion: INITIAL_TEMPLATE_VERSION,
    interface: templateInterfaceOf(subNode),
  };
  await writeJson(join(templateDir, "template.json"), JSON.stringify(template, null, 2));
  return template;
}
