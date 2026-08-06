// 命令安全护栏（v0.4.2）：高危命令黑名单 + AI 生成命令人工审核信号。
// 仅定义核心守卫逻辑与错误类型；Engine 层桥接（catch ReviewRequiredError 转挂起）由其他任务实现。

/** 命令被黑名单拦截（高危操作） */
export class BlacklistedCommandError extends Error {
  readonly name = "BlacklistedCommandError";

  constructor(readonly command: string) {
    super(`命令被黑名单拦截：${command}（高危操作）`);
  }
}

/** 命令待人工审核：引擎层桥接信号，Engine catch 后转为挂起状态 */
export class ReviewRequiredError extends Error {
  readonly name = "ReviewRequiredError";

  constructor(
    readonly nodeId: string,
    readonly description: string,
  ) {
    super(`命令待人工审核：${description}`);
  }
}

/** 高危命令黑名单模式（导出供测试）：命中即拦截 */
export const BLACKLISTED_PATTERNS: readonly RegExp[] = [
  // rm/rmdir 递归删除指向根目录或盘符（如 rm -rf /、rm -rf C:\）
  /^\s*(rm|rmdir)\s+(-[a-z]*\s+)*(-[a-z]*r|-r[a-z]*)\s*[\/\\.]/i,
  // rm/rmdir 递归删除指向盘符路径（如 rm -rf C:\Windows）
  /^\s*(rm|rmdir)\s+(-[a-z]*\s+)*(-[a-z]*r|-r[a-z]*)\s*[a-zA-Z]:[\\\/]/i,
  // Windows del /s：递归删除子目录文件
  /^\s*del\b[^\r\n]*\/s\b/i,
  // Windows 磁盘格式化（如 format c:）
  /^\s*format\s+[a-z]:/i,
  // 关机/重启/断电
  /^\s*(shutdown|reboot|poweroff|halt)\b/i,
  // 创建文件系统，覆盖设备内容
  /^\s*mkfs(?:\.[a-z0-9]+)?\s+/i,
  // dd 直接写入裸设备（如 dd if=/dev/zero of=/dev/sda）
  /^\s*dd\s+if=.*\sof=\/dev\//i,
];

/**
 * 检查命令安全性：黑名单命中抛 BlacklistedCommandError；
 * reviewRequired=true 抛 ReviewRequiredError（黑名单优先，先查黑名单再查审核）。
 * 通过则正常返回。
 */
export function checkCommandSafety(
  command: string,
  reviewRequired: boolean | undefined,
): void {
  for (const pattern of BLACKLISTED_PATTERNS) {
    if (pattern.test(command)) {
      throw new BlacklistedCommandError(command);
    }
  }
  if (reviewRequired === true) {
    throw new ReviewRequiredError("", command);
  }
}
