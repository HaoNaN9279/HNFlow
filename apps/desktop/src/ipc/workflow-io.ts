// 工作流文件读写纯逻辑（T11）：空模板生成、保存校验写盘、错误中文翻译。
// 与 handlers.ts 分离：不依赖 electron dialog（GUI），loadWorkflow/saveWorkflow 核心逻辑可独立验证。

import type { Workflow } from "../../../../src/model/types.js";
import { fromJSON, toJSON } from "../../../../src/serialization/index.js";
import { saveWorkflow } from "../../../../src/storage/index.js";
import type { WorkflowTemplate } from "../shared/ipc.js";

/** 空工作流（workflow:new 数据源）：id 时间戳、version 对齐新建模板。 */
export function emptyWorkflow(): Workflow {
  return { id: `workflow-${Date.now()}`, name: "未命名工作流", version: "0.1.0", nodes: [], edges: [] };
}

/** 经核心 workflowSchema 校验的空模板（workflow:new 返回；校验失败抛 "Invalid workflow: ..."）。 */
export function validatedWorkflowTemplate(): WorkflowTemplate {
  const json = toJSON(emptyWorkflow());
  return { id: json.id, name: json.name, version: json.version, nodes: json.nodes, edges: json.edges };
}

/**
 * 校验并原子写盘：fromJSON（workflowSchema 校验）→ saveWorkflow（内部 toJSON 二次校验 + 原子写）。
 * verifyTemplates（模板引用存在性校验）暂不接入：桌面端尚无模板库目录，接入了会让含模板引用的
 * 工作流全部拦截在「模板不存在」，待桌面模板目录落地后再接（v0.4.0 后）。
 */
export async function saveWorkflowToFile(filePath: string, raw: unknown): Promise<void> {
  await saveWorkflow(filePath, fromJSON(raw));
}

/** errno 风格错误消息（如 "ENOENT: ..." / "EACCES: ..."），fs 失败由核心库透传。 */
const ERRNO_RE = /^[A-Z][A-Z0-9_]*: /;

/** 核心库错误 → 中文友好错误：非法工作流转「工作流数据不合法」，fs 失败转「文件操作失败」，中文错误原样保留。 */
export function friendlyWorkflowError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.message.startsWith("Invalid workflow")) {
    return new Error(`工作流数据不合法：${error.message.replace(/^Invalid workflow( JSON)?[: ]*/, "")}`);
  }
  if (ERRNO_RE.test(error.message)) {
    return new Error(`文件操作失败：${error.message}`);
  }
  return error;
}
