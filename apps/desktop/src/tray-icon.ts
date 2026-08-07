// 系统托盘图标（T2 托盘驻留）：base64 内嵌 16x16 RGBA PNG（蓝色圆点），幂等写出到 userData/icons/tray.png。
// 与 main.ts 薄层分离：本模块只负责落盘图标文件并返回路径；Tray 对象创建在 main.ts。
// 无图标资源文件：base64 为手工生成的真实有效 PNG（PNG signature + IHDR + IDAT + IEND，zlib deflate 校验过）。

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 图标目录名（位于 userData 下）。 */
const ICON_DIR = "icons";

/** 图标文件名。 */
const ICON_FILE = "tray.png";

/** 16x16 RGBA 蓝色圆点 PNG 的 base64（108 字节，IHDR 宽高=16，IDAT 解压=1040 字节）。 */
const TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNwav3CQAmmSDM+A/7jwAQNwKURp0FUNYBYzSiGjBpAZQMGPh1QJSnTPzcCAHXMNqN3Qn9wAAAAAElFTkSuQmCC";

/** 模块级解码一次：幂等比对与原子写共用。 */
const TRAY_PNG = Buffer.from(TRAY_PNG_BASE64, "base64");

/** 确保托盘图标文件存在并返回其路径；已存在且内容一致则跳过（幂等，不重复写）。 */
export async function ensureTrayIcon(userDataDir: string): Promise<string> {
  const filePath = join(userDataDir, ICON_DIR, ICON_FILE);
  if (await hasSameIcon(filePath)) {
    return filePath;
  }
  await writeIconAtomic(filePath);
  return filePath;
}

/** 已有图标与内嵌 base64 解码结果一致则 true；不存在/不可读视为需要写入。 */
async function hasSameIcon(filePath: string): Promise<boolean> {
  try {
    const existing = await readFile(filePath);
    return existing.equals(TRAY_PNG);
  } catch {
    return false;
  }
}

/** 原子写图标：tmp 写入 → rename 替换（参照 src/storage/atomic.ts 模式；失败清理 tmp 不掩盖原始错误）。 */
async function writeIconAtomic(filePath: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tmpPath, TRAY_PNG);
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // 清理失败不影响原始错误抛出
    }
    throw error;
  }
}
