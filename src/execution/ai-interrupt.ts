// AI 中断挂起/恢复支持（v0.2.1）：引擎将 AiInterruptRequiredError 转 HumanTask、恢复时经注入 handler 继续。
// 独立模块保持 Engine.ts ≤440 行（logs-integration 约束测试）。事务边界由 Engine 控制：
// ai 节点执行前 begin → checkpoint（executor 写入）→ HumanTask create → RunState update 同事务（AC3），
// 无中断 rollback（checkpoint 不落库），中断 commit。引擎私有状态经 AiOps 参数化注入，无循环依赖。
import { AiInterruptRequiredError, type AIExecutionResult } from "../ai/executor.js";
import type { SqliteDatabase, SqliteTransaction } from "../db/index.js";
import type { HumanTaskStoreLike } from "../db/stores/types.js";
import type { HumanTask } from "../human/types.js";
import type { Node, Workflow } from "../model/types.js";
import type { NodeStateMachine, NodeStatus } from "./NodeState.js";
import { buildResultFromEngine } from "./runstate-persist.js";
import type { ExecutionEvents, ExecutionResult } from "./Engine.js";

/** AI 中断恢复上下文：引擎从任务 meta 解析，交给注入的 aiResumeHandler（闭包持有 model/tools/interrupt 配置）。 */
export interface AIResumeContext {
  readonly threadId: string;
  readonly checkpointId: string;
  readonly decisions: readonly AiDecision[];
}

/** 人工审批决策：approve 批准工具调用，reject 拒绝（可附 message）。 */
export type AiDecision = { readonly type: "approve" | "reject"; readonly message?: string };

/** AI 挂起节点结果（对齐引擎 RunNodeOutcome 的 waiting/failed 分支）。 */
export type AiOutcome =
  | { readonly kind: "waiting"; readonly task: HumanTask }
  | { readonly kind: "failed"; readonly message: string };

/** 判断任务是否为 AI 工具审批中断任务（meta.kind === "ai_interrupt"）。 */
export function isAiInterruptTask(task: HumanTask): boolean {
  return task.meta?.["kind"] === "ai_interrupt";
}

/** 从任务 meta 解析恢复上下文：threadId/checkpointId；缺失返回 undefined。 */
export function parseAiTaskMeta(task: HumanTask): { readonly threadId: string; readonly checkpointId: string } | undefined {
  const meta = task.meta;
  if (meta === undefined) return undefined;
  const threadId = meta["threadId"];
  const checkpointId = meta["checkpointId"];
  if (typeof threadId !== "string" || typeof checkpointId !== "string") return undefined;
  return { threadId, checkpointId };
}

/** 人工审批输入 → langgraph decisions：result 形如 { type: "approve" | "reject", message? }。 */
export function toAiDecisions(result: unknown): readonly AiDecision[] {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (record["type"] === "approve" || record["type"] === "reject") {
      const message = record["message"];
      return typeof message === "string"
        ? [{ type: record["type"], message }]
        : [{ type: record["type"] }];
    }
  }
  return [{ type: "approve" }];
}

/** AI 审批任务标题：从中断值首个 actionRequest 提取工具名。 */
export function buildAiTaskTitle(signal: AiInterruptRequiredError): string {
  const value = signal.interruptValue;
  if (typeof value === "object" && value !== null) {
    const actionRequests = (value as { actionRequests?: unknown }).actionRequests;
    if (Array.isArray(actionRequests)) {
      const name = (actionRequests[0] as { name?: unknown } | undefined)?.name;
      if (typeof name === "string") return `AI 工具审批：${name}`;
    }
  }
  return "AI 工具审批";
}

/** ai 节点 + SQLite 共享连接时开启事务（AI 执行期间 checkpoint 写入被纳入该事务）。 */
export function beginAiTransaction(
  ai: { readonly dbPath: string; readonly sharedDb?: SqliteDatabase } | undefined,
  node: Node | undefined,
): SqliteTransaction | undefined {
  if (node?.type === "ai" && ai?.sharedDb !== undefined) {
    return ai.sharedDb.db.begin();
  }
  return undefined;
}

/** AI 挂起任务 upsert：先查 pending 复用；无则查最近任务（多轮中断）reopen + 更新 meta；否则新建。
 *  多轮中断复用同一任务 id，meta 更新为新 checkpointId（同一审批流持续）。 */
export async function upsertAiTask(
  store: HumanTaskStoreLike,
  workflowId: string,
  node: Node,
  signal: AiInterruptRequiredError,
): Promise<HumanTask> {
  const meta = {
    kind: "ai_interrupt",
    threadId: signal.threadId,
    checkpointId: signal.checkpointId,
    interruptValue: signal.interruptValue,
  };
  const pending = await store.findPending(workflowId, node.id);
  if (pending !== undefined) return pending;
  const recent = await store.findRecent(workflowId, node.id);
  if (recent !== undefined) {
    return store.reopen(recent.id, meta);
  }
  return store.create({
    workflowId,
    nodeId: node.id,
    nodeName: node.name,
    title: buildAiTaskTitle(signal),
    description: signal.description,
    fallback: "manual",
    meta,
  });
}

/** 引擎私有状态/操作注入面：ai-interrupt 模块不直接访问 ExecutionEngine 私有成员，经此参数化。 */
export interface AiOps {
  readonly workflow: Workflow;
  readonly nodeById: ReadonlyMap<string, Node>;
  readonly machines: ReadonlyMap<string, NodeStateMachine>;
  readonly states: Map<string, NodeStatus>;
  readonly outputs: Map<string, Record<string, unknown>>;
  readonly store: HumanTaskStoreLike;
  readonly ai: { readonly dbPath: string; readonly sharedDb?: SqliteDatabase } | undefined;
  readonly aiResumeHandler: ((context: AIResumeContext) => Promise<AIExecutionResult>) | undefined;
  readonly events: ExecutionEvents | undefined;
  readonly topoSort: (workflow: Workflow) => readonly string[];
  /** 事务内写 RunState waiting（persist=true 时；AC3 三写同事务）。 */
  readonly persistWaiting: (nodeId: string, taskId: string) => Promise<void>;
  readonly emit: (nodeId: string, from: NodeStatus, to: NodeStatus) => void;
  readonly setContext: (key: string, value: unknown) => void;
  readonly taskStartIndex: (task: HumanTask, order: readonly string[]) => number;
  /** 从指定索引继续执行剩余节点（多轮恢复成功后调用）。 */
  readonly startRemaining: (startIndex: number) => Promise<ExecutionResult>;
}

/** AI 中断挂起：转入 WaitingForHuman → 事务内创建/复用任务 + 写 RunState → commit（AC3 三写同事务）。
 *  事务由调用方在 ai 执行前开启（checkpoint 已写入同一共享连接）；失败回滚后节点 Failed。 */
export async function suspendAiNode(
  ops: AiOps,
  node: Node,
  machine: NodeStateMachine,
  signal: AiInterruptRequiredError,
  aiTx: SqliteTransaction | undefined,
): Promise<AiOutcome> {
  try {
    if (ops.states.get(node.id) !== "WaitingForHuman") {
      machine.transitionTo("WaitingForHuman");
      ops.states.set(node.id, "WaitingForHuman");
      ops.emit(node.id, "Running", "WaitingForHuman");
    }
    const task = await upsertAiTask(ops.store, ops.workflow.id, node, signal);
    await ops.persistWaiting(node.id, task.id);
    aiTx?.commit();
    ops.events?.onHumanTaskCreated?.(task);
    return { kind: "waiting", task };
  } catch (cause) {
    aiTx?.rollback();
    machine.transitionTo("Failed");
    ops.states.set(node.id, "Failed");
    ops.emit(node.id, "Running", "Failed");
    const message = `${node.name}(${node.id}) failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    ops.events?.onError?.(cause instanceof Error ? cause : new Error(message));
    return { kind: "failed", message };
  }
}

/** AI 任务恢复：用户审批输入 → decisions；result 缺省复用任务已存 result（恢复失败重试直接复用）。 */
export async function resumeAiTask(ops: AiOps, task: HumanTask, result?: unknown): Promise<ExecutionResult> {
  const storedResult = result === undefined ? task.result : result;
  return continueAiTask(ops, task, toAiDecisions(storedResult), storedResult, "resume failed");
}

/** AI 任务跳过：转 reject 决策恢复 agent 继续执行（拒绝本次工具调用）。 */
export async function skipAiTask(ops: AiOps, task: HumanTask): Promise<ExecutionResult> {
  return continueAiTask(ops, task, [{ type: "reject", message: "用户跳过" }], { type: "reject", message: "用户跳过" }, "skip failed");
}

/** AI 恢复通用流程：complete → 事务内调 aiResumeHandler → 节点 Success + 输出 → 从任务节点后继续。
 *  再次中断（多轮审批）：复用同一任务 reopen + 更新 meta；其它失败：任务 reopen 回 pending（AC4 不丢输入）。 */
export async function continueAiTask(
  ops: AiOps,
  task: HumanTask,
  decisions: readonly AiDecision[],
  storedResult: unknown,
  failureMessage: string,
): Promise<ExecutionResult> {
  const meta = parseAiTaskMeta(task);
  if (meta === undefined) {
    throw new Error(`${failureMessage}：AI 任务缺少恢复上下文: ${task.id}`);
  }
  const handler = ops.aiResumeHandler;
  if (handler === undefined) {
    throw new Error(`${failureMessage}：AI 任务恢复需要注入 aiResumeHandler: ${task.id}`);
  }
  await ops.store.complete(task.id, storedResult);
  const node = ops.nodeById.get(task.nodeId);
  const aiTx = beginAiTransaction(ops.ai, node);
  try {
    const aiResult = await handler({ threadId: meta.threadId, checkpointId: meta.checkpointId, decisions });
    aiTx?.rollback(); // 恢复完成且未再中断：本轮 checkpoint 不落库（仅中断挂起才需 checkpoint）
    const machine = ops.machines.get(task.nodeId);
    if (machine !== undefined) {
      if (machine.status === "WaitingForHuman") {
        machine.transitionTo("Running");
        ops.states.set(task.nodeId, "Running");
        ops.emit(task.nodeId, "WaitingForHuman", "Running");
      }
      machine.transitionTo("Success");
      ops.states.set(task.nodeId, "Success");
      ops.emit(task.nodeId, "Running", "Success");
    }
    ops.setContext(`task_result:${task.nodeId}`, storedResult);
    ops.outputs.set(task.nodeId, {
      output: aiResult.output,
      messages: aiResult.messages,
      toolCalls: aiResult.toolCalls,
    });
    const order = ops.topoSort(ops.workflow);
    const startIndex = ops.taskStartIndex(task, order);
    if (startIndex === -1) {
      throw new Error(`${failureMessage}: task node not in workflow: ${task.nodeId}`);
    }
    return ops.startRemaining(startIndex + 1);
  } catch (err) {
    if (err instanceof AiInterruptRequiredError) {
      // 多轮中断：恢复后 agent 再次请求审批 → 复用同一任务（reopen + 更新 meta 为新 checkpointId）。
      const machine = ops.machines.get(task.nodeId);
      if (node === undefined || machine === undefined) {
        aiTx?.rollback();
        throw err;
      }
      const outcome = await suspendAiNode(ops, node, machine, err, aiTx);
      return aiOutcomeResult(ops, outcome, Date.now());
    }
    aiTx?.rollback();
    // 恢复失败：任务 reopen 回 pending，用户输入保留（AC4），重试可直接复用。
    await ops.store.reopen(task.id);
    throw err;
  }
}

/** suspendAiNode 结果 → ExecutionResult（多轮中断 resume 路径：waiting/failed 结果构造 + onComplete）。 */
function aiOutcomeResult(ops: AiOps, outcome: AiOutcome, startTime: number): ExecutionResult {
  if (outcome.kind === "waiting") {
    const result = buildResultFromEngine(ops.workflow, ops.states, ops.outputs, "waiting", startTime, undefined, outcome.task);
    ops.events?.onComplete?.(result);
    return result;
  }
  const result = buildResultFromEngine(ops.workflow, ops.states, ops.outputs, "failed", startTime, outcome.message);
  ops.events?.onComplete?.(result);
  return result;
}
