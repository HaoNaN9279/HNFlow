// 异常恢复（v0.5.0 T5）：扫描未完成工作流（status=running 残留断点）、恢复决策、中文提示、自动恢复执行。
// 与 electron 薄层分离：不 import electron；纯函数（扫描/决策/文案）可 bun test 直测，
// 恢复执行（recoverInterruptedRuns）参数化注入 store/根目录，main.ts 仅构造 store 并调用。
import type { RunStateStoreLike } from "../../../src/db/stores/types.js";
import { buildEngineFromRunState, continueRun } from "../../../src/execution/resume.js";
import { McpServerPool } from "../../../src/mcp/pool.js";
import type { RunState } from "../../../src/runstate/types.js";

/** 扫描可恢复 run：仅 status === "running"（异常退出时未写 success/failed 的残留断点）。 */
export function scanRecoverableRuns(runs: readonly RunState[]): readonly RunState[] {
  return runs.filter((run) => run.status === "running");
}

/**
 * 恢复决策：有可恢复 run 时给出中文提示（message，含数量）；
 * autoRecover=true → 直接恢复（recover=true）；缺省仅提示不自动恢复（recover=false）。
 */
export function decideRecovery(
  runs: readonly RunState[],
  options: { readonly autoRecover?: boolean } = {},
): { readonly recover: boolean; readonly message?: string } {
  const count = scanRecoverableRuns(runs).length;
  if (count === 0) {
    return { recover: false };
  }
  return { recover: options.autoRecover === true, message: recoveryMessage(count) };
}

/** 中文恢复提示：「检测到 N 个未完成的工作流，正在恢复…」 */
export function recoveryMessage(count: number): string {
  return `检测到 ${count} 个未完成的工作流，正在恢复…`;
}

/** 恢复执行选项：模板/功能组库根目录（供恢复工作流中的 template 引用/功能组节点使用）。 */
export interface RecoveryOptions {
  readonly templatesRootDir: string;
  readonly groupsRootDir: string;
}

/**
 * 自动恢复（验收 3）：扫描 status=running 残留断点 → 逐 run 重建引擎续跑剩余节点。
 * 恢复与正常运行同语义：persist=true 逐节点落盘，终态 success/failed 写回，避免下次启动重复恢复。
 * 恢复路径不携带幂等键（idempotency.ts 注释语义）：恢复是继续原运行而非新提交，重复注册会被判重拒绝抛冲突。
 * 单 run 失败 try/catch 各自跳过，不阻塞其余；恢复结束统一释放 MCP 池。
 */
export async function recoverInterruptedRuns(store: RunStateStoreLike, options: RecoveryOptions): Promise<void> {
  const runs = await store.list();
  const decision = decideRecovery(runs, { autoRecover: true });
  if (!decision.recover) {
    return; // 无可恢复 run：静默
  }
  console.log(`[recover] ${decision.message ?? ""}`);
  const pool = new McpServerPool(); // 恢复可能含 AI/mcpTool 节点：单次池，恢复结束统一释放。
  try {
    for (const run of scanRecoverableRuns(runs)) {
      try {
        const engine = buildEngineFromRunState(omitIdempotencyKey(run), {
          persist: true,
          runStateStore: store,
          templatesRootDir: options.templatesRootDir,
          groupsRootDir: options.groupsRootDir,
          mcpPool: pool,
        });
        const result = await continueRun(engine, run);
        console.log(
          `[recover] 恢复完成 runId=${run.runId} status=${result.status}${result.error === undefined ? "" : ` ${result.error}`}`,
        );
      } catch (error) {
        // 标记 failed：否则 status 仍 running，下次启动重复尝试恢复同一 run（死循环）。
        try {
          await store.update({ ...run, status: "failed" });
        } catch (markError) {
          console.error(`[recover] 恢复失败且标记 failed 失败 runId=${run.runId}`, markError);
        }
        console.error(`[recover] 恢复失败 runId=${run.runId}（已标记 failed，不再重试）`, error);
      }
    }
  } finally {
    await pool.dispose(); // 恢复结束释放 MCP 子进程，严禁长驻。
  }
}

/** 恢复路径豁免幂等键：恢复是继续原运行而非新提交，重复注册会被 createIfAbsent 判重拒绝抛冲突。 */
function omitIdempotencyKey(run: RunState): RunState {
  const { idempotencyKey: _omitted, ...rest } = run;
  return rest;
}
