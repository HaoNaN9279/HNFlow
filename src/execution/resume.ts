// 断点恢复入口：从 RunState 重建引擎（buildEngineFromRunState）、继续执行（continueRun）、
// 顶层 API resumeRun / resumeTask / skipTask。
import type { HumanTask } from "../human/types.js";
import { HumanTaskStore, InvalidTaskStateError } from "../human/HumanTaskStore.js";
import { RunStateNotFoundError, RunStateStore } from "../runstate/RunStateStore.js";
import type { RunState } from "../runstate/types.js";
import { ExecutionEngine } from "./Engine.js";
import type { ExecutionEngineOptions, ExecutionResult } from "./Engine.js";
import { topoSort } from "./Engine.js";
import { DebugController } from "./DebugController.js";

/** 由断点快照重建引擎：workflow 取快照、runId 固定为快照 runId、恢复内部状态后只读（isReadOnly=true）。 */
export function buildEngineFromRunState(runState: RunState, options: ExecutionEngineOptions = {}): ExecutionEngine {
  const engine = new ExecutionEngine(runState.workflow, {
    ...options,
    runId: runState.runId,
    persist: options.persist ?? false,
  });
  engine.restoreState(runState.nodeStates, runState.nodeOutputs, runState.contextSnapshot);
  return engine;
}

/** 定位断点并继续：优先重跑第一个 Failed 节点，否则从第一个 Idle 继续；全部完成直接返回 success。 */
export async function continueRun(engine: ExecutionEngine, runState: RunState): Promise<ExecutionResult> {
  const order = topoSort(runState.workflow);
  const firstFailed = order.find((id) => runState.nodeStates[id] === "Failed");
  const startId = firstFailed ?? order.find((id) => (runState.nodeStates[id] ?? "Idle") === "Idle");
  if (startId === undefined) {
    // 全部节点已终止态：不重跑任何节点，直接返回 success 结果。
    return successResultFromRunState(runState);
  }
  return engine.runFrom(order.indexOf(startId));
}

/** 按 runId 恢复执行（waiting 拒绝用 resumeTask；paused 拒绝用 debugResume）。 */
export async function resumeRun(runId: string, options: ExecutionEngineOptions = {}): Promise<ExecutionResult> {
  const store = options.runStateStore ?? new RunStateStore();
  const runState = await store.getById(runId);
  if (runState === undefined) {
    throw new RunStateNotFoundError(runId);
  }
  if (runState.status === "waiting") {
    throw new Error("run is waiting, use resumeTask instead");
  }
  if (runState.status === "paused") {
    throw new Error("run is paused, use debugResume instead");
  }
  return continueRun(buildEngineFromRunState(runState, options), runState);
}

/** 断点恢复单步意图（v0.2.4 T3）：over=停拓扑序下一节点；into=进入子图停首节点；continue/缺省=清单步只停断点。 */
export type DebugResumeStep = { readonly mode: "over" | "into" | "continue" };

export interface DebugResumeOptions extends ExecutionEngineOptions {
  readonly step?: DebugResumeStep;
}

/** 断点恢复入口：按 runId 恢复执行（status="paused" 专属；从断点节点本身继续，不重跑断点前节点）。
 *  从 RunState.debug.breakpoints 还原断点；构造/复用 DebugController；
 *  consumeResumeNode(pendingNodeId) 消费断点节点一次命中，避免恢复后立即再次 pause 同一节点死循环；
 *  子图暂停（pendingNodeId 为子图内部节点）用 pausedWorkflowId 链回溯容器节点后从容器重跑。 */
export async function debugResume(runId: string, options: DebugResumeOptions = {}): Promise<ExecutionResult> {
  const store = options.runStateStore ?? new RunStateStore();
  const runState = await store.getById(runId);
  if (runState === undefined) {
    throw new RunStateNotFoundError(runId);
  }
  if (runState.status !== "paused") {
    throw new Error(`run is not paused: ${runState.status}, use resumeRun/resumeTask instead`);
  }
  const pendingNodeId = runState.pendingNodeId;
  if (pendingNodeId === undefined) {
    throw new Error("paused run state missing pendingNodeId");
  }
  const controller = options.debugController ?? new DebugController();
  controller.setBreakpoints(runState.debug?.breakpoints ?? []);
  const engine = buildEngineFromRunState(runState, { ...options, debugController: controller });
  const order = topoSort(runState.workflow);
  // 子图暂停恢复：pendingNodeId 为子图内部节点（可能与父节点 id 冲突），用 pausedWorkflowId 链回溯容器节点；
  // 普通断点暂停直接用 pendingNodeId。
  let resumeNodeId: string;
  let startIndex: number;
  const pausedWorkflowId = runState.debug?.pausedWorkflowId;
  if (pausedWorkflowId !== undefined) {
    const containerId = containerFromWorkflowId(pausedWorkflowId, order);
    if (containerId === undefined) {
      throw new Error(`debugResume: container node not in workflow: ${pausedWorkflowId}`);
    }
    resumeNodeId = containerId;
    startIndex = order.indexOf(containerId);
  } else {
    resumeNodeId = pendingNodeId;
    startIndex = order.indexOf(pendingNodeId);
    if (startIndex === -1) {
      throw new Error(`debugResume: pending node not in workflow: ${pendingNodeId}`);
    }
  }
  // 单步意图：over=armStepOver(order[index+1])；into=armStepInto（子引擎透传停首节点）；continue=清 mode。
  const stepMode = options.step?.mode ?? "continue";
  if (stepMode === "over") {
    const nextNodeId = order[startIndex + 1];
    if (nextNodeId === undefined) {
      throw new Error("debugResume: step over at last node");
    }
    controller.armStepOver(nextNodeId);
  } else if (stepMode === "into") {
    controller.armStepInto();
  } else {
    controller.continueRun();
  }
  controller.consumeResumeNode(resumeNodeId);
  return engine.runFrom(startIndex);
}

/** 子图暂停定位：pausedWorkflowId（父id:容器id...）从后往前逐段匹配父 order（照 Engine.taskStartIndex 冒号分段回溯）。 */
function containerFromWorkflowId(workflowId: string | undefined, order: readonly string[]): string | undefined {
  if (workflowId === undefined) return undefined;
  const segments = workflowId.split(":");
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && order.includes(segment)) return segment;
  }
  return undefined;
}

/** 按人工任务 id 恢复执行：读任务 → 定位所属 runState（pendingTaskId 匹配）→ 重建引擎 → engine.resume。
 *  result 为人工产物：不传时 human 节点恢复后会再次挂起（读到 task_result 为空）。 */
export async function resumeTask(
  taskId: string,
  options: ExecutionEngineOptions = {},
  result?: unknown,
): Promise<ExecutionResult> {
  await requirePendingTask(taskId, options);
  const runState = await findRunStateByTaskId(taskId, options);
  return buildEngineFromRunState(runState, options).resume(taskId, result);
}

/** 按人工任务 id 跳过执行：定位 runState → 重建引擎 → engine.skip（下游自动跳过传播）。 */
export async function skipTask(taskId: string, options: ExecutionEngineOptions = {}): Promise<ExecutionResult> {
  await requirePendingTask(taskId, options);
  const runState = await findRunStateByTaskId(taskId, options);
  return buildEngineFromRunState(runState, options).skip(taskId);
}

/** 校验任务存在且 pending，否则抛 InvalidTaskStateError。 */
async function requirePendingTask(taskId: string, options: ExecutionEngineOptions): Promise<HumanTask> {
  const store = options.humanTaskStore ?? new HumanTaskStore();
  const task = await store.getById(taskId);
  if (task === undefined || task.status !== "pending") {
    throw new InvalidTaskStateError(taskId, task?.status ?? "not found");
  }
  return task;
}

/** 扫描断点快照，定位 pendingTaskId 匹配的 runState。 */
async function findRunStateByTaskId(taskId: string, options: ExecutionEngineOptions): Promise<RunState> {
  const store = options.runStateStore ?? new RunStateStore();
  const runs = await store.list();
  const runState = runs.find((run) => run.pendingTaskId === taskId);
  if (runState === undefined) {
    throw new Error(`no run state found for pending task: ${taskId}`);
  }
  return runState;
}

/** 全部完成时直接构造 success 结果（不重跑任何节点）。 */
function successResultFromRunState(runState: RunState): ExecutionResult {
  return {
    workflowId: runState.workflowId,
    status: "success",
    nodeStates: { ...runState.nodeStates },
    nodeOutputs: runState.nodeOutputs,
    startTime: runState.updatedAt,
    endTime: Date.now(),
  };
}
