// logs 子命令：查看指定 run 的运行详情（runId/status/error 等）与逐节点状态；
// 追加 --workflow 时再打印工作流结构。
import { RunStateStore } from "../runstate/RunStateStore.js";
import type { RunState } from "../runstate/types.js";
import { describeError, fail, printTable } from "./util.js";

const DEFAULT_STORE = "./run_states.json";

/** bun run src/cli/index.ts logs <runId> [storePath] [--workflow] */
export async function cmdLogs(args: readonly string[]): Promise<number> {
  const runId = args[0];
  if (runId === undefined) {
    return fail("缺少 runId", "logs <runId> [storePath] [--workflow]");
  }
  const storePath = args[1] ?? DEFAULT_STORE;
  const withWorkflow = args.includes("--workflow");
  try {
    const store = new RunStateStore({ filePath: storePath });
    const run = await store.getById(runId);
    if (run === undefined) {
      return fail(`未找到运行记录: ${runId}`, "logs <runId> [storePath]");
    }
    printRunDetail(run);
    if (withWorkflow) printWorkflowDetail(run);
    return 0;
  } catch (error) {
    return fail(describeError(error), "logs <runId> [storePath]");
  }
}

function printRunDetail(run: RunState): void {
  console.log(`runId: ${run.runId}`);
  console.log(`workflowId: ${run.workflowId}`);
  console.log(`status: ${run.status}`);
  console.log(`updatedAt: ${new Date(run.updatedAt).toLocaleString()}`);
  if (run.error !== undefined) console.log(`error: ${run.error}`);
  if (run.pendingNodeId !== undefined) console.log(`pendingNodeId: ${run.pendingNodeId}`);
  if (run.pendingTaskId !== undefined) console.log(`pendingTaskId: ${run.pendingTaskId}`);
  console.log("节点状态:");
  const rows = Object.entries(run.nodeStates).map(([nodeId, status]) => [nodeId, status]);
  if (rows.length === 0) {
    console.log("  （无节点状态）");
  } else {
    printTable(["nodeId", "status"], rows);
  }
}

function printWorkflowDetail(run: RunState): void {
  console.log(`工作流结构 (${run.workflow.nodes.length} 节点 / ${run.workflow.edges.length} 边):`);
  for (const node of run.workflow.nodes) {
    console.log(`  ${node.id} [${node.type}] ${node.name}`);
  }
  for (const edge of run.workflow.edges) {
    console.log(`  ${edge.sourceNodeId}.${edge.sourcePortId} -> ${edge.targetNodeId}.${edge.targetPortId}`);
  }
}
