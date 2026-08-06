// 内存单次运行纯逻辑（v0.4.2 桌面最小运行能力）：workflow 校验 → ExecutionEngine 内存跑 → 结果/错误组装。
// 与 handlers.ts 分离：不依赖 electron dialog/app，runWorkflowOnce 可独立验证（bun test 直跑）。
// 不持久化：不传 persist/runStateStore/logStore；运行是一次性 await，结束即返回，无长驻进程。

import { randomUUID } from "node:crypto";
import { ExecutionEngine, type ExecutionResult } from "../../../../src/execution/Engine.js";
import { formatNodePath } from "../../../../src/execution/node-path.js";
import type { EngineLogEntry } from "../../../../src/execution/engine-util.js";
import { McpServerPool } from "../../../../src/mcp/pool.js";
import { fromJSON } from "../../../../src/serialization/index.js";
import type { RunDebugInfo, RunWorkflowPayload, RunWorkflowResult } from "../shared/ipc.js";

/** 运行选项：templatesRootDir 供 template 引用节点读目录（缺省引擎默认 ./templates）。 */
export interface RunWorkflowOptions {
  readonly templatesRootDir?: string;
  /** 功能组库根目录（v0.4.3 验收 3）：提供后引擎运行时加载节点声明的功能组，AI 节点经 MCP 池消费组内 MCP 工具。 */
  readonly groupsRootDir?: string;
  /** 审核请求回调（v0.4.2 验收 2）：运行到待审核 command 节点时调用，返回批准/拒绝；缺省拒绝。 */
  readonly onReviewRequest?: (request: {
    readonly requestId: string;
    readonly nodeId: string;
    readonly description: string;
  }) => Promise<"approve" | "reject">;
}

/**
 * 内存单次运行：fromJSON（workflowSchema 校验）→ 新引擎（无持久化）→ await run()。
 * 失败不抛错：一律收敛为 { ok: false, message 中文 }，成功 { ok: true, runId }。
 * MCP 池（v0.4.3 验收 3）：每次运行新建进程池供 AI/mcpTool 节点消费，无论成败 finally 释放，无残留子进程。
 */
export async function runWorkflowOnce(
  payload: RunWorkflowPayload,
  options: RunWorkflowOptions = {},
): Promise<RunWorkflowResult> {
  const pool = new McpServerPool(); // 单次运行专属进程池：运行结束统一释放（同 name 复用由池内引用计数管理）。
  try {
    let engine: ExecutionEngine;
    try {
      const workflow = fromJSON(payload.workflow); // 非法数据在此抛 "Invalid workflow JSON: ..."
      const onReviewRequest = options.onReviewRequest;
      engine = new ExecutionEngine(workflow, {
        workflowVariables: {},
        ...(options.templatesRootDir === undefined ? {} : { templatesRootDir: options.templatesRootDir }),
        ...(options.groupsRootDir === undefined ? {} : { groupsRootDir: options.groupsRootDir }),
        mcpPool: pool, // 引擎注入 MCP 池：AI 节点 activeGroups.mcps / mcpTool 节点消费
        // 审核桥接（v0.4.2 验收 2）：引擎询问 → 外层回调（requestId 由本层生成，每次触发唯一）。
        ...(onReviewRequest === undefined
          ? {}
          : {
              onReviewRequired: async (info) => onReviewRequest({ requestId: randomUUID(), ...info }),
            }),
      });
    } catch (error) {
      return { ok: false, message: friendlyRunError(error) };
    }
    try {
      const result = await engine.run(); // 节点失败不抛：result.status === "failed" + result.error
      if (result.status === "success") {
        return { ok: true, runId: engine.runId, debug: buildDebugInfo(engine, result) };
      }
      return failureResult(engine, result);
    } catch (error) {
      // run() 抛错：工作流成环等引擎级错误。
      return { ok: false, message: friendlyRunError(error) };
    }
  } finally {
    await pool.dispose(); // 成功与失败路径都释放：MCP 子进程立即退出，严禁长驻。
  }
}

/** 核心库错误 → 中文友好消息：非法工作流/成环转中文，其余原样保留。 */
export function friendlyRunError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.message.startsWith("Invalid workflow")) {
    return `工作流数据不合法：${error.message.replace(/^Invalid workflow( JSON)?[: ]*/, "")}`;
  }
  if (error.message.startsWith("workflow cycle detected")) {
    return `工作流存在循环依赖，无法运行：${error.message.replace(/^workflow cycle detected: /, "")}`;
  }
  return error.message;
}

/** markNodeFailed 写入的错误格式：`节点名(节点id) failed: 错误消息`（Engine.ts）。 */
const NODE_FAIL_RE = /^(.+)\(([^)]+)\) failed: (.*)$/s;

/** 从引擎错误日志取人类可读节点路径（markNodeFailed 已注入 data.nodePath，T7 就绪）。 */
function extractNodePath(engine: ExecutionEngine): string | undefined {
  for (const log of engine.logs) {
    const path = nodePathOf(log);
    if (path !== undefined) {
      return path;
    }
  }
  return undefined;
}

/** 日志拿不到路径时兜底：formatNodePath(workflowId 链, nodeId, 节点名映射)。 */
function fallbackNodePath(engine: ExecutionEngine, nodeId: string | undefined): string | undefined {
  if (nodeId === undefined) {
    return undefined;
  }
  const workflow = engine.workflowSnapshot;
  return formatNodePath(workflow.id, nodeId, (id) => workflow.nodes.find((node) => node.id === id)?.name);
}

/** 单条日志 data.nodePath 类型守卫（data 为 unknown，不能直接断言）。 */
function nodePathOf(log: EngineLogEntry): string | undefined {
  const data = log.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const raw = (data as Readonly<Record<string, unknown>>)["nodePath"];
  return typeof raw === "string" ? raw : undefined;
}

/** 组装单次运行调试信息（成功/失败共用，T2b）：运行元数据 + 节点状态/输出 + 上下文快照 + 引擎日志。 */
function buildDebugInfo(engine: ExecutionEngine, result: ExecutionResult): RunDebugInfo {
  return {
    runId: engine.runId,
    nodeStates: result.nodeStates,
    nodeOutputs: result.nodeOutputs,
    contextSnapshot: engine.contextSnapshot,
    // EngineLogEntry 与 IpcLogEntry 形状一致，直接透传（查错依据：失败节点路径/错误消息在日志 data 内）。
    logs: engine.logs,
    startTime: result.startTime,
    endTime: result.endTime,
  };
}

/** 非 success 结果 → 失败 RunWorkflowResult：解析失败节点 id + 中文消息 + 节点路径 + 调试信息。 */
function failureResult(engine: ExecutionEngine, result: ExecutionResult): RunWorkflowResult {
  const raw = result.status === "failed" ? (result.error ?? "工作流执行失败") : statusMessage(result.status);
  const match = raw.match(NODE_FAIL_RE);
  const nodeId = match?.[2];
  const nodePath = extractNodePath(engine) ?? fallbackNodePath(engine, nodeId);
  const message = match === null ? raw : `节点「${match[1]}」执行失败：${match[3]}`;
  return {
    ok: false,
    message,
    debug: buildDebugInfo(engine, result),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(nodePath === undefined ? {} : { nodePath }),
  };
}

/** waiting/paused 无 result.error，给中文说明（内存单次运行不支持挂起继续）。 */
function statusMessage(status: ExecutionResult["status"]): string {
  if (status === "waiting") {
    return "工作流执行到等待人工任务的节点，当前版本暂不支持挂起继续";
  }
  if (status === "paused") {
    return "工作流执行到暂停节点，当前版本暂不支持恢复";
  }
  return "工作流执行失败";
}
