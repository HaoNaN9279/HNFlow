// workflows 子命令路由：无子命令/首参非子命令 → 按 [dir] 列出目录工作流（向后兼容）；check/upgrade 分派独立实现。
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkflow } from "../storage/index.js";
import { describeError, fail, printTable } from "./util.js";
import { cmdWorkflowsCheck } from "./workflows-check.js";
import { cmdWorkflowsUpgrade } from "./workflows-upgrade.js";

const DEFAULT_DIR = "./workflows";

/**
 * bun run src/cli/index.ts workflows [dir] | workflows check <file> [...] | workflows upgrade <file> [...]
 * 首参是 check/upgrade → 分派子命令；否则视为目录（缺省 ./workflows）。
 */
export async function cmdWorkflows(args: readonly string[]): Promise<number> {
  const sub = args[0];
  if (sub === "check") return cmdWorkflowsCheck(args.slice(1));
  if (sub === "upgrade") return cmdWorkflowsUpgrade(args.slice(1));
  return listWorkflows(sub);
}

/** 列出目录下 .json 工作流文件，打印文件名与工作流概要（id/name/节点数/边数）。 */
async function listWorkflows(dir: string | undefined): Promise<number> {
  const target = dir ?? DEFAULT_DIR;
  const usage = "workflows [dir]";
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(target)).isDirectory();
  } catch {
    return fail(`工作流目录不存在: ${target}`, usage);
  }
  if (!isDirectory) {
    return fail(`不是目录: ${target}`, usage);
  }
  const files = (await readdir(target)).filter((name) => name.toLowerCase().endsWith(".json"));
  if (files.length === 0) {
    console.log(`目录 ${target} 下没有 .json 工作流文件`);
    return 0;
  }
  const rows: string[][] = [];
  for (const name of files) {
    try {
      const workflow = await loadWorkflow(join(target, name));
      rows.push([
        name,
        workflow.id,
        workflow.name,
        `${workflow.nodes.length}/${workflow.edges.length}`,
      ]);
    } catch (error) {
      // 单个文件损坏：警告并继续，不中断其他文件的列出。
      console.error(`警告: 跳过损坏的工作流文件 ${name}: ${describeError(error)}`);
    }
  }
  printTable(["文件", "workflow.id", "workflow.name", "节点/边"], rows);
  return 0;
}
