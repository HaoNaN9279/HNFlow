// 原子写文件公共工具：tmp 写入 → 读回校验 → rename 原子替换。
// 供 storage/RunStateStore/HumanTaskStore 共用，消除三份重复实现。
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 原子写入文件：mkdir 父目录（recursive）→ 写 `${filePath}.tmp`（UTF-8）→
 * 传入 validate 则读回校验（可解析即认为写入完整）→ rename 原子替换。
 * 任一步失败清理残留 tmp 并抛原始错误，原文件不受损。
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  validate?: (text: string) => void,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tmpPath, content, "utf8");
    if (validate !== undefined) {
      const written = await readFile(tmpPath, "utf8");
      validate(written); // 完整性校验：可解析即认为写入完整
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await removeFileQuietly(tmpPath);
    throw error;
  }
}

/** 尽力清理文件；ENOENT 忽略（从未创建或已清理），其他清理失败不掩盖原始错误。 */
export async function removeFileQuietly(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return;
    // no-excuse-ok: catch — 清理失败不影响原始错误的抛出
  }
}

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
