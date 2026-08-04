// HNFlow CLI 主入口：解析子命令并分发。main 为纯函数（便于测试），
// 直接执行时按返回码 process.exit；被 import 时不退出。
import { cmdLogs } from "./logs.js";
import { cmdRun } from "./run.js";
import { cmdRuns } from "./runs.js";
import { cmdWorkflows } from "./workflows.js";
import { fail } from "./util.js";

/** 全命令用法提示（stderr）。 */
function printUsage(): void {
  console.error("HNFlow CLI 用法:");
  console.error("  workflows [dir]           列出工作流文件（默认 ./workflows）");
  console.error("  runs [storePath]          列出运行记录（默认 ./run_states.json）");
  console.error("  logs <runId> [storePath]  查看运行详情与节点状态（--workflow 附结构）");
  console.error("  run <workflowPath>        加载并执行工作流");
}

/**
 * CLI 入口纯函数：返回进程退出码（0 成功，非 0 失败）。
 * argv 为 process.argv；bun 下 argv[1] 是脚本路径，参数从 argv[2] 起。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[2];
  const args = argv.slice(3);
  switch (command) {
    case "workflows":
      return cmdWorkflows(args);
    case "runs":
      return cmdRuns(args);
    case "logs":
      return cmdLogs(args);
    case "run":
      return cmdRun(args);
    case undefined:
      printUsage();
      return 1;
    default:
      return fail(`未知命令: ${command}`, "workflows|runs|logs|run");
  }
}

// 直接执行（bun run src/cli/index.ts ...）时按退出码退出。
if (import.meta.main) {
  process.exit(await main(process.argv));
}
