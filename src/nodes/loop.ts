// 循环节点：按 items 迭代执行 body 子图，收集各迭代 endResult 输出 results。
// 迭代进度写入 node 级上下文（执行前写，挂起/失败中断后可从断点恢复）；
// progress 钩子在每次进度推进后调用，persist=true 时引擎据此落盘断点快照。
import type { INodeDefinition, NodeExecutionContext } from "../execution/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { runSubgraph, SubworkflowWaitingError } from "./subgraph-exec.js";

/** loop params 非法：items 无法解析或 body 非 Workflow。 */
export class InvalidLoopParamsError extends Error {
  readonly name = "InvalidLoopParamsError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 迭代次数超上限（防死循环）。 */
export class LoopIterationLimitError extends Error {
  readonly name = "LoopIterationLimitError";

  constructor(readonly length: number, readonly max: number) {
    super(`loop 迭代次数超限: ${length} > ${max}（防死循环）`);
  }
}

/** 单次迭代执行失败（携带子引擎错误消息与迭代序号）。 */
export class LoopFailedError extends Error {
  readonly name = "LoopFailedError";

  constructor(readonly detail: string, readonly iteration: number) {
    super(`loop 迭代 ${iteration} 执行失败: ${detail}`);
  }
}

/** 进度在 node 级作用域的键名。 */
const PROGRESS_KEY = "loopProgress";
/** 已完成迭代结果（endResult 数组）在 node 级作用域的键名。 */
const RESULTS_KEY = "loopResults";
const DEFAULT_MAX_ITERATIONS = 10000;

/** 解析 items 参数：string → 按变量路径读（须为数组）；数组 → 原样；number → [0..n-1]。 */
function parseItems(ctx: NodeExecutionContext, maxIterations: number): unknown[] {
  const raw = ctx.node.params["items"];
  if (typeof raw === "string") {
    const resolved = ctx.getByPath(raw);
    if (resolved === undefined || !Array.isArray(resolved)) {
      throw new InvalidLoopParamsError(`invalid loop items: variable "${raw}" must be an array`);
    }
    return resolved;
  }
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "number") {
    if (raw <= 0) return [];
    if (!Number.isInteger(raw)) {
      throw new InvalidLoopParamsError(
        `invalid loop items: count must be a non-negative integer, got ${raw}`,
      );
    }
    if (raw > maxIterations) throw new LoopIterationLimitError(raw, maxIterations);
    return Array.from({ length: raw }, (_, index) => index);
  }
  throw new InvalidLoopParamsError(
    "invalid loop params: items must be a variable path string, array, or number",
  );
}

/** 子引擎 workflow 变量：迭代上下文 + params 整包 + 父挂起产物透传（照 tryCatch.ts 模式）。 */
function buildWorkflowVariables(
  ctx: NodeExecutionContext,
  items: unknown[],
  index: number,
): Record<string, unknown> {
  const workflowVariables: Record<string, unknown> = {
    loopIndex: index,
    loopItem: items[index],
    loopItems: items,
    loopCount: items.length,
    params: ctx.node.params,
  };
  for (const [key, value] of Object.entries(ctx.getAll("workflow"))) {
    if (key.startsWith("task_result:")) {
      workflowVariables[key] = value;
    }
  }
  return workflowVariables;
}

export const loopNode: INodeDefinition = {
  type: "loop",
  name: "循环",
  inputs: [],
  outputs: [{ id: "results", name: "结果", type: "any", direction: "out" }],
  async execute(ctx) {
    const rawBody = ctx.node.params["body"];
    if (!isWorkflow(rawBody)) {
      throw new InvalidLoopParamsError("invalid loop params: expected { body: Workflow }");
    }
    const rawMax = ctx.node.params["maxIterations"];
    const maxIterations =
      typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0
        ? rawMax
        : DEFAULT_MAX_ITERATIONS;
    const items = parseItems(ctx, maxIterations);
    if (items.length > maxIterations) {
      throw new LoopIterationLimitError(items.length, maxIterations);
    }
    const progressScope = `node:${ctx.node.id}`;
    const saved = ctx.get(progressScope, PROGRESS_KEY);
    const start = typeof saved === "number" && Number.isInteger(saved) ? saved : 0;
    // 已完成迭代的结果从上下文读取：失败/挂起中断恢复后从断点续收集，不重复、不丢失（T8 修复）。
    const savedResults = ctx.get(progressScope, RESULTS_KEY);
    const results: unknown[] = Array.isArray(savedResults) ? [...savedResults] : [];
    for (let i = start; i < items.length; i++) {
      // 执行前写进度：挂起/失败中断后恢复时从本迭代重跑，不丢迭代。
      ctx.set(progressScope, PROGRESS_KEY, i);
      // 分支上下文快照：迭代输入变量浅拷贝写 node:loop:branch:<迭代索引>（调试 CLI 查看分支作用域，
      // 含父继承 + 迭代注入；仅调试呈现，不影响执行语义）。
      const workflowVariables = buildWorkflowVariables(ctx, items, i);
      ctx.set(progressScope, `branch:${i}`, { ...workflowVariables });
      await ctx.progress?.({ loopIndex: i });
      try {
        const { endResult } = await runSubgraph(
          ctx,
          rawBody,
          workflowVariables,
          ctx.registry,
        );
        results.push(endResult);
        // 每迭代完成即写结果：断点快照携带已完成迭代 endResult（拷贝防数组引用污染快照）。
        ctx.set(progressScope, RESULTS_KEY, [...results]);
      } catch (err) {
        // 挂起不是失败：透传父引擎（复用子图已创建任务，不吞）。
        if (err instanceof SubworkflowWaitingError) throw err;
        // 其余错误（含 SubworkflowFailedError 及任意异常）转为 LoopFailedError。
        throw new LoopFailedError(err instanceof Error ? err.message : String(err), i);
      }
    }
    // 全部完成：写终值（loopResults 与 loopProgress=items.length 一致）并触发持久化。
    ctx.set(progressScope, RESULTS_KEY, [...results]);
    ctx.set(progressScope, PROGRESS_KEY, items.length);
    await ctx.progress?.({ loopIndex: items.length });
    return { results };
  },
};
