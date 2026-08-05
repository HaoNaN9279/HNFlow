// 工作流 JSON 文件存储：原子写入（公共 atomicWriteFile）+ 加载。
import { readFile } from "node:fs/promises";
import type { ResolveResult } from "../groups/resolve.js";
import type { Workflow } from "../model/types.js";
import { deserialize, toJSON } from "../serialization/index.js";
import { atomicWriteFile } from "./atomic.js";

/** saveWorkflow 可选项：resolveGroups 为依赖解析钩子（闭包自携带 rootDir），返回 ResolveResult 形状。 */
export interface SaveWorkflowOptions {
  resolveGroups?: (workflow: Workflow) => Promise<ResolveResult>;
}

/**
 * 原子保存：toJSON 校验 → 公共 atomicWriteFile 写同目录 tmp（UTF-8，\n 换行）→
 * 读回 JSON.parse 校验 → rename 原子替换。任一步失败清理残留 tmp 并抛错，原文件不受损。
 * options.resolveGroups 传入时：先解析校验，成功则把 resolvedGroups/resolvedAt 合并进新对象（不改入参）后序列化；
 * 解析抛错（GroupResolveError/GroupScanError 等）→ 透传抛出，不落盘。
 */
export async function saveWorkflow(
  filePath: string,
  workflow: Workflow,
  options?: SaveWorkflowOptions,
): Promise<void> {
  let target: Workflow = workflow;
  if (options?.resolveGroups !== undefined) {
    const result = await options.resolveGroups(workflow); // 解析失败：透传抛出，不落盘
    target = { ...workflow, resolvedGroups: [...result.resolvedGroups], resolvedAt: result.resolvedAt };
  }
  const json = toJSON(target); // 序列化校验失败直接抛错，不落盘
  await atomicWriteFile(filePath, `${JSON.stringify(json, null, 2)}\n`, (text) => JSON.parse(text));
}

/** 加载：读文件 → deserialize。文件不存在抛 ENOENT 友好错误。 */
export async function loadWorkflow(filePath: string): Promise<Workflow> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      throw new Error(`工作流文件不存在 (ENOENT): ${filePath}`);
    }
    throw error;
  }
  return deserialize(text);
}

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
