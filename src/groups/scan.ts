// 功能组内容安全扫描（v0.9.4）：导入后对规则/agent 文本、工具声明、MCP 配置做静态信号检测。
// 非阻塞检查：产出 findings 供用户决策，不影响导入/加载流程（与 command-guard 运行时拦截互补）。
// 误报控制原则：只对完整命令模式/高置信信号告警；普通提及（如"删除请用工具"）不告警。
import { BLACKLISTED_PATTERNS } from "../security/command-guard.js";
import type { LoadedGroupContent, LoadedMcp } from "./content-loader.js";

/** 安全告警严重度。 */
export type SecuritySeverity = "high" | "medium" | "low";
/** 告警类别。 */
export type SecurityCategory = "command" | "script" | "mcp" | "suspicious";

/** 单条安全告警。 */
export interface SecurityFinding {
  readonly severity: SecuritySeverity;
  readonly category: SecurityCategory;
  readonly detail: string;
}

/** 扫描结果：findings 为空表示未发现可疑内容。 */
export interface SecurityReport {
  readonly findings: readonly SecurityFinding[];
}

/** 额外高置信命令模式（超出 command-guard 黑名单的完整命令形态，导出供测试）。 */
export interface ScanPattern {
  readonly name: string;
  readonly pattern: RegExp;
}
export const SCAN_PATTERNS: readonly ScanPattern[] = [
  // curl|wget 管道直灌 shell：远程内容直接执行
  { name: "download-pipe-shell", pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh\b/i },
  // powershell 编码执行（-enc / -encodedCommand）
  { name: "powershell-encoded", pattern: /\bpowershell(?:\.exe)?\s+-enc(?:odedcommand)?\b/i },
  // powershell -e 后跟长 base64（疑似编码载荷）
  { name: "powershell-short-e", pattern: /\bpowershell(?:\.exe)?\s+-e\s+[A-Za-z0-9+/=]{20,}/i },
  // eval 动态执行
  { name: "eval-exec", pattern: /\beval\s*\(/i },
  // python -c 内联脚本
  { name: "python-inline", pattern: /\bpython(?:2|3(?:\.\d+)?)?\s+[^\n]*-c\s+['"]/i },
];

/** 下载执行模式：curl/wget 下载到文件后执行（script/medium）。 */
export const DOWNLOAD_EXECUTE_PATTERN =
  /\b(?:curl|wget)\b[^\n]*\s-(?:o|O)\s+\S+[^\n]*(?:\|\s*(?:ba)?sh\b|(?:&&|;)\s*(?:(?:ba)?sh\b|chmod\s+\+x|\.\/))/i;
/** 连续 base64 长串（疑似加密载荷）。 */
export const BASE64_BLOB_PATTERN = /[A-Za-z0-9+/=]{64,}/;
/** 十六进制转义 \xHH（混淆计数用，需带 g 标志）。 */
export const HEX_ESCAPE_PATTERN = /\\x[0-9a-fA-F]{2}/g;

/** MCP command 危险程序名：basename 匹配（防路径前缀干扰，如 C:\...\rm.exe）。 */
const MCP_DANGEROUS_COMMAND =
  /(?:^|[\\/])(?:rm|rmdir|del|format|mkfs|dd|shutdown|reboot|poweroff|halt)(?:\.exe)?(?:\s|$)/i;
/** MCP command 内嵌 powershell 编码参数。 */
const MCP_POWERSHELL_ENCODED = /\bpowershell(?:\.exe)?\s+-(?:enc(?:odedcommand)?|e\s+[A-Za-z0-9+/=]{20,})/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 匹配片段规范化并截断 80 字符（detail 用）。 */
function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized;
}

/** 扫描单份文本：行级命令/脚本信号 + 全文 \xHH 高频混淆。 */
function scanText(findings: SecurityFinding[], label: string, text: string): void {
  for (const line of text.split("\n")) {
    const fragment = truncate(line);
    for (const pattern of BLACKLISTED_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ severity: "high", category: "command", detail: `${label}：高危命令 ${fragment}` });
        break; // 同命令行只记一条黑名单告警
      }
    }
    for (const scan of SCAN_PATTERNS) {
      if (scan.pattern.test(line)) {
        findings.push({ severity: "high", category: "command", detail: `${label}：${scan.name} ${fragment}` });
      }
    }
    if (BASE64_BLOB_PATTERN.test(line)) {
      findings.push({ severity: "medium", category: "script", detail: `${label}：疑似 base64 加密载荷 ${fragment}` });
    }
    if (DOWNLOAD_EXECUTE_PATTERN.test(line)) {
      findings.push({ severity: "medium", category: "script", detail: `${label}：下载执行模式 ${fragment}` });
    }
  }
  const hexCount = text.match(HEX_ESCAPE_PATTERN)?.length ?? 0;
  if (hexCount > 10) {
    findings.push({ severity: "medium", category: "script", detail: `${label}：编码混淆（\\xHH 出现 ${hexCount} 次）` });
  }
}

/** 扫描单份 MCP 配置：shape 异常 / 危险 command。 */
function scanMcp(findings: SecurityFinding[], mcp: LoadedMcp): void {
  const config = mcp.config;
  if (!isRecord(config)) {
    findings.push({ severity: "low", category: "mcp", detail: `${mcp.name}：MCP config 非对象` });
    return;
  }
  const command = config.command;
  if (command !== undefined && typeof command !== "string") {
    findings.push({ severity: "low", category: "mcp", detail: `${mcp.name}：MCP config.command 非字符串（shape 异常）` });
  } else if (
    typeof command === "string" &&
    (MCP_DANGEROUS_COMMAND.test(command) || MCP_POWERSHELL_ENCODED.test(command))
  ) {
    findings.push({ severity: "medium", category: "mcp", detail: `${mcp.name}：MCP command 为危险程序 ${truncate(command)}` });
  }
}

/**
 * 扫描功能组内容：规则/agent 文本高危命令与可疑脚本、工具声明、MCP 配置异常。
 * 非阻塞：返回 findings 而非抛错；findings 空 = 干净。
 */
export function scanGroupContent(content: LoadedGroupContent): SecurityReport {
  const findings: SecurityFinding[] = [];
  for (const rule of content.rules) {
    scanText(findings, rule.path, rule.text);
  }
  if (content.agent !== undefined) {
    scanText(findings, "agent.md", content.agent.text);
  }
  for (const tool of content.tools) {
    scanText(findings, tool.path, `${tool.name}\n${tool.description}`);
  }
  for (const mcp of content.mcps) {
    scanMcp(findings, mcp);
  }
  return { findings };
}
