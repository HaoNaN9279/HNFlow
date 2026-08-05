// template 子命令（v0.3.3 T6）：子工作流模板 CLI 入口。
// template create 打包工作流节点创建模板（v0.1.0）；template release 发布新版本；template list 列出模板；template history 查看版本历史。
// 参数解析与打印惯例对齐 groups.ts / workflows-check.ts（util.ts 的 printTable/fail/describeError）。
import { compareSemVer, parseSemVer } from "../groups/semver.js";
import { loadWorkflow } from "../storage/index.js";
import { createTemplate, validateTemplateName } from "../templates/create.js";
import { releaseTemplate } from "../templates/release.js";
import { findTemplateByName, scanTemplates } from "../templates/load.js";
import type { WorkflowTemplate } from "../templates/types.js";
import { describeError, fail, printTable } from "./util.js";

const DEFAULT_DIR = "./templates";

/** bun run src/cli/index.ts template <子命令> ... */
export async function cmdTemplate(args: readonly string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "create":
      return cmdTemplateCreate(args.slice(1));
    case "release":
      return cmdTemplateRelease(args.slice(1));
    case "list":
      return cmdTemplateList(args.slice(1));
    case "history":
      return cmdTemplateHistory(args.slice(1));
    case undefined:
      return fail("缺少子命令", "template create|release|list|history");
    default:
      return fail(`未知子命令: ${sub}`, "template create|release|list|history");
  }
}

/** template create 参数解析结果：error 非空时直接 fail（缺值 / 未知选项 / 多余参数）。 */
interface CreateArgs {
  name?: string;
  workflowFile?: string;
  nodeIds?: string;
  dir?: string;
  description?: string;
  error?: string;
}

/** 手工解析 template create 参数：位置参数依次为 name、workflow-file、nodes；--dir/--description 带值。 */
function parseCreateArgs(args: readonly string[]): CreateArgs {
  const result: CreateArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // noUncheckedIndexedAccess 越界防御
    if (arg === "--dir" || arg === "--description") {
      const value = args[i + 1];
      if (value === undefined) return { error: `选项 ${arg} 缺少值` };
      if (arg === "--dir") result.dir = value;
      else result.description = value;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知选项: ${arg}` };
    positional.push(arg);
  }
  if (positional[0] !== undefined) result.name = positional[0];
  if (positional[1] !== undefined) result.workflowFile = positional[1];
  if (positional[2] !== undefined) result.nodeIds = positional[2];
  if (positional[3] !== undefined) return { error: `多余参数: ${positional[3]}` };
  return result;
}

/** template create <name> <workflow-file> <nodes> [--dir <dir>] [--description <text>]：打包工作流节点创建模板。 */
async function cmdTemplateCreate(args: readonly string[]): Promise<number> {
  const usage = "template create <name> <workflow-file> <nodes> [--dir <dir>]";
  const parsed = parseCreateArgs(args);
  if (parsed.error !== undefined) return fail(parsed.error, usage);
  const name = parsed.name;
  const workflowFile = parsed.workflowFile;
  const nodeIdsRaw = parsed.nodeIds;
  if (name === undefined) return fail("缺少模板名", usage);
  if (workflowFile === undefined) return fail("缺少工作流文件", usage);
  if (nodeIdsRaw === undefined) return fail("缺少节点列表", usage);
  // 节点列表解析：逗号分隔，空段（如 "a,,b"）视为非法。
  const nodeIds = nodeIdsRaw.split(",");
  if (nodeIds.some((id) => id === "")) {
    return fail(`节点列表格式非法："${nodeIdsRaw}"（逗号分隔，如 a,b,c）`, usage);
  }
  const dir = parsed.dir ?? DEFAULT_DIR;
  try {
    const workflow = await loadWorkflow(workflowFile);
    const template = await createTemplate(dir, name, workflow, nodeIds, parsed.description);
    console.log(`已创建模板 ${template.name} v${template.currentVersion}（${dir}）`);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** template release 参数解析结果：error 非空时直接 fail（缺值 / 未知选项 / 多余参数）。 */
interface ReleaseArgs {
  name?: string;
  dir?: string;
  version?: string;
  changelog?: string;
  error?: string;
}

/** 手工解析 template release 参数：-v 必填 / -c、--dir 可选；位置参数仅 name。 */
function parseReleaseArgs(args: readonly string[]): ReleaseArgs {
  const result: ReleaseArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // noUncheckedIndexedAccess 越界防御
    if (arg === "-v" || arg === "-c" || arg === "--dir") {
      const value = args[i + 1];
      if (value === undefined) return { error: `选项 ${arg} 缺少值` };
      if (arg === "-v") result.version = value;
      else if (arg === "-c") result.changelog = value;
      else result.dir = value;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知选项: ${arg}` };
    positional.push(arg);
  }
  if (positional[0] !== undefined) result.name = positional[0];
  if (positional[1] !== undefined) return { error: `多余参数: ${positional[1]}` };
  return result;
}

/** template release <name> -v <version> [--dir <dir>] [-c <changelog>]：发布新版本。 */
async function cmdTemplateRelease(args: readonly string[]): Promise<number> {
  const usage = "template release <name> -v <version> [--dir <dir>] [-c <changelog>]";
  const parsed = parseReleaseArgs(args);
  if (parsed.error !== undefined) return fail(parsed.error, usage);
  const name = parsed.name;
  const version = parsed.version;
  if (name === undefined) return fail("缺少模板名", usage);
  if (version === undefined) return fail("缺少版本号（-v <version>）", usage);
  // 格式校验前置：模板名/版本非法直接 fail（含用法），不触碰文件系统。
  try {
    validateTemplateName(name);
    parseSemVer(version);
  } catch (error) {
    return fail(describeError(error), usage);
  }
  const dir = parsed.dir ?? DEFAULT_DIR;
  try {
    const template = await releaseTemplate(dir, name, version, parsed.changelog);
    console.log(`已发布 ${template.name} v${template.currentVersion}（${parsed.changelog ?? "更新"}）`);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** template list [dir]：列出模板表格；空目录提示；根目录缺失 fail。 */
async function cmdTemplateList(args: readonly string[]): Promise<number> {
  const usage = "template list [dir]";
  const dir = args[0] ?? DEFAULT_DIR;
  let templates: WorkflowTemplate[];
  try {
    templates = await scanTemplates(dir);
  } catch (error) {
    return fail(describeError(error), usage);
  }
  if (templates.length === 0) {
    console.log(`目录 ${dir} 下没有模板`);
    return 0;
  }
  printTable(
    ["模板名", "当前版本", "版本数", "描述"],
    templates.map((template) => [
      template.name,
      template.currentVersion,
      String(template.versions.length),
      template.description,
    ]),
  );
  return 0;
}

/** template history <name> [dir]：列出版本历史表格（语义版本降序，当前版本在最上）。 */
async function cmdTemplateHistory(args: readonly string[]): Promise<number> {
  const usage = "template history <name> [dir]";
  const name = args[0];
  if (name === undefined) return fail("缺少模板名", usage);
  const dir = args[1] ?? DEFAULT_DIR;
  try {
    const template = await findTemplateByName(dir, name);
    if (template === undefined) {
      return fail(`模板不存在：${name}（${dir}）`, usage);
    }
    // 语义版本降序：字符串排序会把 "1.10.0" 排在 "1.9.0" 前（错误），必须 parseSemVer + compareSemVer。
    const sorted = [...template.versions].sort((a, b) => -compareSemVer(parseSemVer(a.version), parseSemVer(b.version)));
    printTable(
      ["版本", "创建时间", "changelog"],
      sorted.map((version) => [version.version, version.createdAt, version.changelog]),
    );
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}
