// workflows check 子命令（v0.3.2 T7）：对比工作流依赖快照 resolvedGroups 与各组 currentVersion，输出可升级表格。
// 忽略文件默认 <file 所在目录>/.hnflow-updates.json（格式 { "ignored": string[] }），缺失视为空、损坏视为空。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkGroupUpdates } from "../groups/updates.js";
import { loadWorkflow } from "../storage/index.js";
import { describeError, fail, printTable } from "./util.js";

const DEFAULT_GROUPS_DIR = "./groups";
const DEFAULT_IGNORE_FILE = ".hnflow-updates.json";

interface CheckArgs {
  file?: string;
  groupsDir?: string;
  ignoreFile?: string;
  error?: string;
}

/** 手工解析参数：--groups/--ignore-file 带值选项 + 1 个位置参数 file；未知选项/多余参数报错。 */
function parseCheckArgs(args: readonly string[]): CheckArgs {
  const result: CheckArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // noUncheckedIndexedAccess 越界防御
    if (arg === "--groups" || arg === "--ignore-file") {
      const value = args[i + 1];
      if (value === undefined) return { error: `选项 ${arg} 缺少值` };
      if (arg === "--groups") result.groupsDir = value;
      else result.ignoreFile = value;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知选项: ${arg}` };
    positional.push(arg);
  }
  if (positional.length > 1) return { error: `多余参数: ${positional[1]}` };
  if (positional[0] !== undefined) result.file = positional[0];
  return result;
}

/** 读忽略文件：缺失（ENOENT）返回空数组；JSON 解析失败/无 ignored 数组返回空数组（容错，不阻断检查）。 */
async function readIgnoreFile(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const ignored = (parsed as { readonly ignored?: unknown }).ignored;
  return Array.isArray(ignored) ? ignored.filter((item): item is string => typeof item === "string") : [];
}

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** bun run src/cli/index.ts workflows check <file> [--groups <dir>] [--ignore-file <path>] */
export async function cmdWorkflowsCheck(args: readonly string[]): Promise<number> {
  const usage = "workflows check <file> [--groups <dir>] [--ignore-file <path>]";
  const parsed = parseCheckArgs(args);
  if (parsed.error !== undefined) return fail(parsed.error, usage);
  const file = parsed.file;
  if (file === undefined) return fail("缺少工作流文件", usage);
  const groupsDir = parsed.groupsDir ?? DEFAULT_GROUPS_DIR;
  const ignoreFile = parsed.ignoreFile ?? join(dirname(file), DEFAULT_IGNORE_FILE);
  try {
    const workflow = await loadWorkflow(file);
    if (workflow.resolvedGroups === undefined || workflow.resolvedGroups.length === 0) {
      console.log("工作流无功能组依赖快照");
      return 0;
    }
    const ignores = await readIgnoreFile(ignoreFile);
    const report = await checkGroupUpdates(groupsDir, workflow, { ignores });
    if (report.entries.length === 0) {
      console.log("没有可升级的功能组");
    } else {
      printTable(
        ["功能组", "锁定版本", "最新版本", "升级类型"],
        report.entries.map((entry) => [entry.namespace, entry.lockedVersion, entry.latestVersion, entry.diff]),
      );
    }
    if (report.ignoredCount > 0) console.log(`已忽略 ${report.ignoredCount} 个版本更新`);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}
