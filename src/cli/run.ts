// run 子命令：加载工作流 → ExecutionEngine 执行 → 打印状态、节点状态表、节点输出摘要与引擎日志。
// v0.2.5 T5：--idempotency-key <key> 开启持久化（SQLite store，--store 指定 dbPath，缺省 ./hnflow.db 项目惯例），
// 重复键抛 IdempotencyKeyConflictError → stderr 报错 + 非零退出；无键保持现状（不 persist）。
// v0.3.1 T7：--groups <dir> 指定功能组根目录，透传 ExecutionEngineOptions.groupsRootDir（运行时节点按需加载）。
// v0.3.3 T6：--templates <dir> 指定子工作流模板根目录（缺省 ./templates），透传 ExecutionEngineOptions.templatesRootDir。
import { stat } from "node:fs/promises";
import { ExecutionEngine, IdempotencyKeyConflictError, type ExecutionEngineOptions } from "../execution/Engine.js";
import { loadWorkflow } from "../storage/index.js";
import { SqliteRunStateStore } from "../db/index.js";
import type { RunStateStoreLike } from "../db/stores/types.js";
import { describeError, fail, jsonSummary, printTable } from "./util.js";

const DEFAULT_DB = "./hnflow.db";
const DEFAULT_TEMPLATES_DIR = "./templates";

interface RunArgs {
  workflowPath?: string;
  idempotencyKey?: string;
  dbPath?: string;
  groupsDir?: string;
  templatesDir?: string;
  error?: string;
}

/** 手工解析 run 参数：首个位置参数为工作流路径；--idempotency-key/--store/--groups/--templates 各取下一值；未知选项或缺值报错。 */
function parseRunArgs(args: readonly string[]): RunArgs {
  const result: RunArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--idempotency-key" || arg === "--store" || arg === "--groups" || arg === "--templates") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `选项 ${arg} 缺少值` };
      if (arg === "--idempotency-key") result.idempotencyKey = value;
      else if (arg === "--store") result.dbPath = value;
      else if (arg === "--groups") result.groupsDir = value;
      else result.templatesDir = value;
      i++;
      continue;
    }
    if (arg.startsWith("--")) return { error: `未知选项: ${arg}` };
    if (result.workflowPath !== undefined) return { error: `多余参数: ${arg}` };
    result.workflowPath = arg;
  }
  return result;
}

/** 幂等冲突时从 store 查已有 runId（IdempotencyKeyConflictError 本身不带 runId）。 */
async function findExistingRunId(
  store: RunStateStoreLike,
  workflowId: string,
  idempotencyKey: string,
): Promise<string | undefined> {
  const runs = await store.list();
  return runs.find((run) => run.workflowId === workflowId && run.idempotencyKey === idempotencyKey)?.runId;
}

/** bun run src/cli/index.ts run <workflowPath> [--idempotency-key <key>] [--store <dbPath>] [--groups <dir>] [--templates <dir>] */
export async function cmdRun(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  const usage = "run <workflowPath> [--idempotency-key <key>] [--store <dbPath>] [--groups <dir>] [--templates <dir>]";
  if (parsed.error !== undefined) return fail(parsed.error, usage);
  const workflowPath = parsed.workflowPath;
  if (workflowPath === undefined) return fail("缺少工作流路径", usage);
  const idempotencyKey = parsed.idempotencyKey;
  let activeStore: SqliteRunStateStore | undefined;
  try {
    const workflow = await loadWorkflow(workflowPath);
    if (parsed.groupsDir !== undefined) {
      const info = await stat(parsed.groupsDir);
      if (!info.isDirectory()) {
        return fail(`功能组根目录不是目录：${parsed.groupsDir}`, usage);
      }
    }
    let engineOptions: ExecutionEngineOptions = { workflowVariables: {} };
    if (idempotencyKey !== undefined) {
      const store = new SqliteRunStateStore(parsed.dbPath ?? DEFAULT_DB);
      activeStore = store;
      engineOptions = { workflowVariables: {}, persist: true, idempotencyKey, runStateStore: store };
    }
    if (parsed.groupsDir !== undefined) {
      engineOptions = { ...engineOptions, groupsRootDir: parsed.groupsDir };
    }
    // 模板根目录（缺省 ./templates）：透传 ExecutionEngineOptions.templatesRootDir（引擎缺省一致，仅 template 引用时读目录）。
    engineOptions = { ...engineOptions, templatesRootDir: parsed.templatesDir ?? DEFAULT_TEMPLATES_DIR };
    const engine = new ExecutionEngine(workflow, engineOptions);
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
    if (error instanceof IdempotencyKeyConflictError) {
      const existingRunId =
        activeStore === undefined ? undefined : await findExistingRunId(activeStore, error.workflowId, error.idempotencyKey);
      return fail(
        existingRunId === undefined ? error.message : `${error.message}（已有 runId: ${existingRunId}）`,
        usage,
      );
    }
    return fail(describeError(error), usage);
  } finally {
    await activeStore?.close();
  }
}
