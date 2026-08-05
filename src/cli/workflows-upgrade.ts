// workflows upgrade 子命令（v0.3.2 T7）：按门槛升级工作流功能组声明版本与模板引用版本，保存到原文件。
// 门槛：--all 全开；--patch/--minor/--major 分别开 autoPatch/allowMinor/allowMajor；无 flag 等价预览（不升不保存）。
// 忽略文件默认 <file 所在目录>/.hnflow-updates.json（格式 { "ignored": string[] }），缺失视为空、损坏视为空。
// 保存链：先 upgradeWorkflow（刷新 capabilityGroups + resolvedGroups/resolvedAt），再 upgradeTemplateRefs（更新
// params.template），两函数均返回新 workflow 对象，最终保存第二次结果。saveWorkflow 传入 verifyTemplates 钩子
// （templatesDir 闭包），模板引用缺失时拦截不落盘。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { upgradeWorkflow, type UpgradeOptions } from "../groups/upgrade.js";
import { upgradeTemplateRefs, type TemplateUpgradeOptions } from "../templates/upgrade.js";
import { verifyTemplateRefs } from "../templates/verify-refs.js";
import { loadWorkflow, saveWorkflow } from "../storage/index.js";
import { describeError, fail } from "./util.js";

const DEFAULT_GROUPS_DIR = "./groups";
const DEFAULT_TEMPLATES_DIR = "./templates";
const DEFAULT_IGNORE_FILE = ".hnflow-updates.json";

interface UpgradeArgs {
  file?: string;
  groupsDir?: string;
  templatesDir?: string;
  all?: boolean;
  patch?: boolean;
  minor?: boolean;
  major?: boolean;
  ignoreFile?: string;
  error?: string;
}

/** 手工解析参数：带值选项 --groups/--templates/--ignore-file + 开关 --all/--patch/--minor/--major + 1 个位置参数 file。 */
function parseUpgradeArgs(args: readonly string[]): UpgradeArgs {
  const result: UpgradeArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // noUncheckedIndexedAccess 越界防御
    if (arg === "--groups" || arg === "--templates" || arg === "--ignore-file") {
      const value = args[i + 1];
      if (value === undefined) return { error: `选项 ${arg} 缺少值` };
      if (arg === "--groups") result.groupsDir = value;
      else if (arg === "--templates") result.templatesDir = value;
      else result.ignoreFile = value;
      i++;
      continue;
    }
    if (arg === "--all") {
      result.all = true;
      continue;
    }
    if (arg === "--patch") {
      result.patch = true;
      continue;
    }
    if (arg === "--minor") {
      result.minor = true;
      continue;
    }
    if (arg === "--major") {
      result.major = true;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知选项: ${arg}` };
    positional.push(arg);
  }
  if (positional.length > 1) return { error: `多余参数: ${positional[1]}` };
  if (positional[0] !== undefined) result.file = positional[0];
  return result;
}

/** 门槛映射：--all 全开；否则各自 flag 对应开关（均缺省 → 全关闭）。功能组与模板共用同一组开关。 */
function toUpgradeOptions(args: UpgradeArgs): UpgradeOptions {
  const all = args.all === true;
  return {
    ...(all || args.patch === true ? { autoPatch: true } : {}),
    ...(all || args.minor === true ? { allowMinor: true } : {}),
    ...(all || args.major === true ? { allowMajor: true } : {}),
  };
}

/** 读忽略文件：缺失（ENOENT）返回空数组；JSON 解析失败/无 ignored 数组返回空数组（容错，不阻断升级）。 */
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

/**
 * bun run src/cli/index.ts workflows upgrade <file> [--groups <dir>] [--templates <dir>] [--all] [--patch] [--minor] [--major] [--ignore-file <path>]
 * 无任何可升级且无跳过 → 提示并返回；有 skipped 无 upgraded → 仅打印提示不落盘（无实际变更）；
 * 有 upgraded → 打印明细并 saveWorkflow 保存（保存前校验模板引用存在性）。
 */
export async function cmdWorkflowsUpgrade(args: readonly string[]): Promise<number> {
  const usage =
    "workflows upgrade <file> [--groups <dir>] [--templates <dir>] [--all] [--patch] [--minor] [--major] [--ignore-file <path>]";
  const parsed = parseUpgradeArgs(args);
  if (parsed.error !== undefined) return fail(parsed.error, usage);
  const file = parsed.file;
  if (file === undefined) return fail("缺少工作流文件", usage);
  const groupsDir = parsed.groupsDir ?? DEFAULT_GROUPS_DIR;
  const templatesDir = parsed.templatesDir ?? DEFAULT_TEMPLATES_DIR;
  const ignoreFile = parsed.ignoreFile ?? join(dirname(file), DEFAULT_IGNORE_FILE);
  try {
    const workflow = await loadWorkflow(file);
    const ignores = await readIgnoreFile(ignoreFile);
    const upgradeOpts: TemplateUpgradeOptions = toUpgradeOptions(parsed);
    // 先升级功能组（刷新 capabilityGroups + resolvedGroups/resolvedAt），再升级模板引用（更新 params.template），
    // 两个函数都作用于同一 workflow 对象链，最终保存第二次结果。
    const groupResult = await upgradeWorkflow(groupsDir, workflow, { ...upgradeOpts, ignores });
    const templateResult = await upgradeTemplateRefs(templatesDir, groupResult.workflow, {
      ...upgradeOpts,
      ignores,
    });

    for (const entry of groupResult.upgraded) {
      console.log(`${entry.guid}@${entry.from} → ${entry.to}（${entry.diff}）`);
    }
    for (const entry of templateResult.upgraded) {
      console.log(`${entry.name}@${entry.from} → ${entry.to}（${entry.diff}）`);
    }
    for (const entry of templateResult.skipped) {
      console.log(`跳过 ${entry.name}（端口不匹配）`);
    }

    if (groupResult.upgraded.length === 0 && templateResult.upgraded.length === 0) {
      if (templateResult.skipped.length === 0) {
        console.log("没有可升级的功能组/模板");
      }
      return 0; // 无实际升级：仅 skipped 时打印提示，不保存
    }

    await saveWorkflow(file, templateResult.workflow, {
      verifyTemplates: (wf) => verifyTemplateRefs(templatesDir, wf),
    });
    console.log(`已保存: ${file}`);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}
