// 工作流 JSON 文件存储：原子写入（tmp + 完整性校验 + rename）+ 加载。
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Workflow } from "../model/types.js";
import { deserialize, toJSON } from "../serialization/index.js";

/**
 * 原子保存：toJSON 校验 → 写同目录 tmp（UTF-8，\n 换行）→ 读回 JSON.parse 校验 →
 * rename 原子替换。任一步失败清理残留 tmp 并抛错，原文件不受损。
 */
export async function saveWorkflow(filePath: string, workflow: Workflow): Promise<void> {
  const json = toJSON(workflow); // 序列化校验失败直接抛错，不落盘
  const tmpPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tmpPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
    const written = await readFile(tmpPath, "utf8");
    JSON.parse(written); // 完整性校验：可解析即认为写入完整
    await rename(tmpPath, filePath);
  } catch (error) {
    await removeTmpQuietly(tmpPath);
    throw error;
  }
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

/** 尽力清理残留 tmp；不存在则忽略，其他清理失败也不掩盖原始错误。 */
async function removeTmpQuietly(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return; // 从未创建或已清理
    // no-excuse-ok: catch — 清理失败不影响原始错误的抛出
  }
}
