// 并行分支节点：多分支子图并发执行、各自独立上下文副本、完成后按合并规则写回父上下文。
// 分支进度写入 node 级上下文（每分支完成即追加 doneBranches + progress，断点快照携带已完成分支，
// 失败/挂起中断恢复时跳过分叉不重复执行/合并）；全部 settle 后聚合：
// 任一失败抛 ParallelBranchFailedError（不合并，失败优先）；无失败且 ≥1 挂起则合并已完成分支后
// 透传第一个 SubworkflowWaitingError；全部成功合并全部 diff 返回 { results: { [branchId]: endResult } }。
import type { INodeDefinition, NodeExecutionContext } from "../execution/types.js";
import type { Workflow } from "../model/types.js";
import { isWorkflow } from "../subgraph/shared.js";
import { runBranch, SubworkflowWaitingError } from "./subgraph-exec.js";

/** parallel params 非法：branches 非数组/为空/id 非法或重复/workflow 非 Workflow/merge.mode 非法。 */
export class InvalidParallelParamsError extends Error {
  readonly name = "InvalidParallelParamsError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 分支合并冲突：errorOnConflict 模式下父作用域已有 key 且分支修改。 */
export class ParallelMergeConflictError extends Error {
  readonly name = "ParallelMergeConflictError";

  constructor(readonly key: string, readonly branchId: string) {
    super(`parallel 分支 ${branchId} 合并冲突: key "${key}" 在父作用域已存在`);
  }
}

/** 分支执行失败聚合（携带分支 id 与错误详情）。 */
export class ParallelBranchFailedError extends Error {
  readonly name = "ParallelBranchFailedError";

  constructor(readonly detail: string, readonly branchId: string) {
    super(`parallel 分支 ${branchId} 执行失败: ${detail}`);
  }
}

/** 分支合并模式：replace=覆盖；mergeArrays=双方数组则拼接；errorOnConflict=父已有 key 则抛错。 */
export type ParallelMergeMode = "replace" | "mergeArrays" | "errorOnConflict";

/** 分支声明：id 唯一标识，workflow 内嵌子图，merge 合并规则（缺省 replace）。 */
export interface ParallelBranchParams {
  readonly id: string;
  readonly workflow: Workflow;
  readonly merge?: { readonly mode: ParallelMergeMode };
}

/** doneBranches（已完成分支 id 数组）在 node 级作用域的键名。 */
const DONE_KEY = "doneBranches";

/** 解析并校验 branches 参数：非空数组、id 非空唯一、workflow 合法、merge.mode 合法。 */
function parseBranches(raw: unknown): ParallelBranchParams[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidParallelParamsError(
      "invalid parallel params: expected { branches: [{ id, workflow, merge? }] } with at least one branch",
    );
  }
  const seen = new Set<string>();
  const branches: ParallelBranchParams[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InvalidParallelParamsError("invalid parallel params: branch must be an object");
    }
    const record = item as Readonly<Record<string, unknown>>;
    const id = record["id"];
    if (typeof id !== "string" || id === "") {
      throw new InvalidParallelParamsError("invalid parallel params: branch id must be a non-empty string");
    }
    if (seen.has(id)) {
      throw new InvalidParallelParamsError(`invalid parallel params: duplicate branch id "${id}"`);
    }
    seen.add(id);
    const workflow = record["workflow"];
    if (!isWorkflow(workflow)) {
      throw new InvalidParallelParamsError(`invalid parallel params: branch "${id}" workflow must be a Workflow`);
    }
    const merge = record["merge"];
    let mergeParams: { readonly mode: ParallelMergeMode } | undefined;
    if (merge !== undefined) {
      if (typeof merge !== "object" || merge === null || Array.isArray(merge)) {
        throw new InvalidParallelParamsError(`invalid parallel params: branch "${id}" merge must be an object`);
      }
      const mode = (merge as Readonly<Record<string, unknown>>)["mode"];
      if (typeof mode !== "string") {
        throw new InvalidParallelParamsError(
          `invalid parallel params: branch "${id}" merge.mode must be "replace" | "mergeArrays" | "errorOnConflict"`,
        );
      }
      if (mode !== "replace" && mode !== "mergeArrays" && mode !== "errorOnConflict") {
        throw new InvalidParallelParamsError(
          `invalid parallel params: branch "${id}" merge.mode must be "replace" | "mergeArrays" | "errorOnConflict"`,
        );
      }
      mergeParams = { mode };
    }
    branches.push(mergeParams === undefined ? { id, workflow } : { id, workflow, merge: mergeParams });
  }
  return branches;
}

/** 分支子引擎 workflow 变量：父 workflow 作用域全量拷贝（含 task_result:* 透传）+ params 整包。 */
function buildBranchVariables(ctx: NodeExecutionContext, _branch: ParallelBranchParams): Record<string, unknown> {
  const workflowVariables = ctx.getAll("workflow");
  workflowVariables["params"] = ctx.node.params;
  return workflowVariables;
}

/** 恢复：读 node 级 doneBranches（已完成分支 id 数组）。 */
function readDoneBranches(ctx: NodeExecutionContext): Set<string> {
  const saved = ctx.get(`node:${ctx.node.id}`, DONE_KEY);
  if (!Array.isArray(saved)) return new Set<string>();
  return new Set(saved.filter((value): value is string => typeof value === "string"));
}

/** 合并 diff：对比初始快照与分支终态 workflow 变量，排除 params 与 task_result:*，按 merge.mode 写回父。 */
function mergeBranchDiff(
  ctx: NodeExecutionContext,
  snapshot: Record<string, unknown>,
  final: Record<string, unknown>,
  branch: ParallelBranchParams,
): void {
  for (const [key, value] of Object.entries(final)) {
    if (key === "params" || key.startsWith("task_result:")) continue;
    if (key in snapshot && snapshot[key] === value) continue;
    const mode = branch.merge?.mode ?? "replace";
    if (mode === "errorOnConflict") {
      if (ctx.get("workflow", key) !== undefined || key in snapshot) {
        throw new ParallelMergeConflictError(key, branch.id);
      }
    }
    if (mode === "mergeArrays") {
      const parent = ctx.get("workflow", key);
      if (Array.isArray(parent) && Array.isArray(value)) {
        ctx.set("workflow", key, [...parent, ...value]);
        continue;
      }
    }
    ctx.set("workflow", key, value);
  }
}

type BranchOutcome =
  | { readonly kind: "skipped"; readonly branchId: string }
  | {
      readonly kind: "success";
      readonly branchId: string;
      readonly snapshot: Record<string, unknown>;
      readonly endResult: unknown;
      readonly variables: Record<string, unknown>;
    }
  | { readonly kind: "error"; readonly branchId: string; readonly error: unknown };

type SuccessOutcome = Extract<BranchOutcome, { readonly kind: "success" }>;

function isFailedOutcome(outcome: BranchOutcome): outcome is { readonly kind: "error"; readonly branchId: string; readonly error: unknown } {
  return outcome.kind === "error" && !(outcome.error instanceof SubworkflowWaitingError);
}

function isWaitingOutcome(outcome: BranchOutcome): outcome is { readonly kind: "error"; readonly branchId: string; readonly error: SubworkflowWaitingError } {
  return outcome.kind === "error" && outcome.error instanceof SubworkflowWaitingError;
}

function isSuccessOutcome(outcome: BranchOutcome): outcome is SuccessOutcome {
  return outcome.kind === "success";
}

export const parallelNode: INodeDefinition = {
  type: "parallel",
  name: "并行分支",
  paramsSchema: [
    { key: "branches", label: "分支定义", type: "json", required: true, description: "[{ id, workflow, merge? }]；画布内嵌子图，参数面板仅展示结构" },
  ],
  inputs: [],
  outputs: [{ id: "results", name: "结果", type: "any", direction: "out" }],
  async execute(ctx) {
    const branches = parseBranches(ctx.node.params["branches"]);
    const branchById = new Map(branches.map((branch) => [branch.id, branch]));
    const progressScope = `node:${ctx.node.id}`;
    const done = readDoneBranches(ctx);
    const settled = await Promise.allSettled(
      branches.map((branch) => {
        if (done.has(branch.id)) {
          // 恢复：已完成分支跳过（其结果已在中断前合并进父上下文，不重复合并）。
          return Promise.resolve({ kind: "skipped", branchId: branch.id } satisfies BranchOutcome);
        }
        const snapshot = buildBranchVariables(ctx, branch);
        return runBranch(ctx, branch.workflow, snapshot, ctx.registry, `:${branch.id}`).then(
          async (branchResult) => {
            // 每分支完成立即追加 doneBranches + progress：断点快照携带已完成分支标记，恢复跳过分叉。
            done.add(branch.id);
            ctx.set(progressScope, DONE_KEY, [...done]);
            // 分支上下文快照：分支终态 workflow 变量浅拷贝写 node:par:branch:<branchId>
            // （父继承 + 分支修改，调试 CLI 查看分支作用域；仅调试呈现，不影响执行语义）。
            ctx.set(progressScope, `branch:${branch.id}`, { ...branchResult.variables });
            await ctx.progress?.({ branchId: branch.id });
            return {
              kind: "success",
              branchId: branch.id,
              snapshot,
              endResult: branchResult.endResult,
              variables: branchResult.variables,
            } satisfies BranchOutcome;
          },
          (error: unknown) => ({ kind: "error", branchId: branch.id, error } satisfies BranchOutcome),
        );
      }),
    );
    // 所有 reject 已被 .then 兜底转 error 结果，此处仅防御性处理理论上不可达的 rejected 条目。
    const outcomes: BranchOutcome[] = settled.map((item) =>
      item.status === "fulfilled"
        ? item.value
        : ({ kind: "error", branchId: "unknown", error: item.reason } satisfies BranchOutcome),
    );
    // 失败优先：任一分支失败（非挂起）→ 抛 ParallelBranchFailedError，不合并已完成分支。
    const failed = outcomes.filter(isFailedOutcome);
    if (failed.length > 0) {
      const first = failed[0];
      if (first !== undefined) {
        throw new ParallelBranchFailedError(
          first.error instanceof Error ? first.error.message : String(first.error),
          first.branchId,
        );
      }
    }
    const successes = outcomes.filter(isSuccessOutcome);
    const waiting = outcomes.filter(isWaitingOutcome);
    if (waiting.length > 0) {
      // 挂起：合并全部已完成分支 diff + progress 后透传第一个 SubworkflowWaitingError（声明顺序）。
      for (const success of successes) {
        const branch = branchById.get(success.branchId);
        if (branch !== undefined) mergeBranchDiff(ctx, success.snapshot, success.variables, branch);
      }
      await ctx.progress?.({ merged: true });
      const firstWaiting = waiting[0];
      if (firstWaiting !== undefined) throw firstWaiting.error;
    }
    for (const success of successes) {
      const branch = branchById.get(success.branchId);
      if (branch !== undefined) mergeBranchDiff(ctx, success.snapshot, success.variables, branch);
    }
    const results: Record<string, unknown> = {};
    for (const success of successes) {
      results[success.branchId] = success.endResult;
    }
    return { results };
  },
};
