// runs 子命令：列出 RunStateStore 中的运行记录（runId/workflowId/status/updatedAt）。
import { RunStateStore } from "../runstate/RunStateStore.js";
import { describeError, fail, printTable } from "./util.js";

const DEFAULT_STORE = "./run_states.json";

/** bun run src/cli/index.ts runs [storePath] */
export async function cmdRuns(args: readonly string[]): Promise<number> {
  const storePath = args[0] ?? DEFAULT_STORE;
  const usage = "runs [storePath]";
  try {
    const store = new RunStateStore({ filePath: storePath });
    const runs = await store.list();
    if (runs.length === 0) {
      // 文件不存在或尚无任何运行记录，均为空列表。
      console.log("无运行记录");
      return 0;
    }
    const rows = runs.map((run) => [
      run.runId,
      run.workflowId,
      run.status,
      new Date(run.updatedAt).toLocaleString(),
    ]);
    printTable(["runId", "workflowId", "status", "updatedAt"], rows);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}
