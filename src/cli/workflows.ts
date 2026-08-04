// workflows 子命令：列出目录下 .json 工作流文件，打印文件名与工作流概要（id/name/节点数/边数）。
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkflow } from "../storage/index.js";
import { describeError, fail, printTable } from "./util.js";

const DEFAULT_DIR = "./workflows";

/** bun run src/cli/index.ts workflows [dir] */
export async function cmdWorkflows(args: readonly string[]): Promise<number> {
  const dir = args[0] ?? DEFAULT_DIR;
  const usage = "workflows [dir]";
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    return fail(`工作流目录不存在: ${dir}`, usage);
  }
  if (!isDirectory) {
    return fail(`不是目录: ${dir}`, usage);
  }
  const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".json"));
  if (files.length === 0) {
    console.log(`目录 ${dir} 下没有 .json 工作流文件`);
    return 0;
  }
  const rows: string[][] = [];
  for (const name of files) {
    try {
      const workflow = await loadWorkflow(join(dir, name));
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
