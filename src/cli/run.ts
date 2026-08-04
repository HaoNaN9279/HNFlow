// run 子命令：加载工作流 → ExecutionEngine 执行 → 打印状态、节点状态表、节点输出摘要与引擎日志。
import { ExecutionEngine } from "../execution/Engine.js";
import { loadWorkflow } from "../storage/index.js";
import { describeError, fail, jsonSummary, printTable } from "./util.js";

/** bun run src/cli/index.ts run <workflowPath> */
export async function cmdRun(args: readonly string[]): Promise<number> {
  const workflowPath = args[0];
  if (workflowPath === undefined) {
    return fail("缺少工作流路径", "run <workflowPath>");
  }
  const usage = "run <workflowPath>";
  try {
    const workflow = await loadWorkflow(workflowPath);
    const engine = new ExecutionEngine(workflow, { workflowVariables: {} });
    const result = await engine.run();

    console.log(`runId: ${engine.runId}`);
    console.log(`workflow: ${workflow.id} (${workflow.name})`);
    console.log(`status: ${result.status}`);
    if (result.error !== undefined) console.log(`error: ${result.error}`);
    if (result.waitingTask !== undefined) {
      console.log(`waitingTask: ${result.waitingTask.id} (${result.waitingTask.title})`);
    }
    console.log(`耗时: ${result.endTime - result.startTime}ms`);
    console.log("节点状态:");
    printTable(
      ["nodeId", "status"],
      workflow.nodes.map((node) => [node.id, result.nodeStates[node.id] ?? "Idle"]),
    );
    console.log("节点输出:");
    for (const node of workflow.nodes) {
      const outputs = result.nodeOutputs[node.id];
      console.log(`  ${node.id}: ${outputs === undefined ? "（无输出）" : jsonSummary(outputs)}`);
    }
    console.log("引擎日志:");
    if (engine.logs.length === 0) {
      console.log("  （无日志）");
    } else {
      for (const log of engine.logs) {
        const data = log.data === undefined ? "" : ` ${jsonSummary(log.data)}`;
        console.log(`  [${log.level}] ${log.message}${data}`);
      }
    }
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}
