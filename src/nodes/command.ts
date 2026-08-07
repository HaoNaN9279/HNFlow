// 命令行执行节点：Bun.spawn 运行外部命令，捕获 stdout/stderr 与退出码。
// 沙箱（v0.9.4）：配置 ctx.sandboxRootDir 时 cwd 缺省强制沙箱根；显式 cwd 必须解析在沙箱内（逃逸拒绝）。

import type { INodeDefinition } from "../execution/types.js";
import { checkCommandSafety, ReviewRequiredError } from "../security/command-guard.js";
import { resolveSandboxPath, SandboxPathError } from "../security/path-sandbox.js";

/** command 节点参数格式非法 */
export class InvalidCommandParamsError extends Error {
  readonly name = "InvalidCommandParamsError";

  constructor(readonly params: unknown) {
    super(
      "invalid command params: expected { command: string, args?, cwd?, timeoutMs?, failOnNonZero?, retry? }",
    );
  }
}

/** 子进程在 timeoutMs 内未退出 */
export class TimeoutError extends Error {
  readonly name = "TimeoutError";

  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`command timed out after ${timeoutMs}ms: ${command}`);
  }
}

/** 非零退出码且 failOnNonZero 为 true */
export class NonZeroExitError extends Error {
  readonly name = "NonZeroExitError";

  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    const summary = stderr.trim().slice(0, 200);
    super(
      `command exited with code ${exitCode}: ${command}${summary === "" ? "" : ` (${summary})`}`,
    );
  }
}

/** 重试配置（v0.2.5 T3）：attempts=重试次数（总执行 attempts+1 次；0/缺省=不重试）；delayMs=每次重试前等待毫秒（缺省 100）。 */
interface RetryOptions {
  readonly attempts: number | undefined;
  readonly delayMs: number;
}

/** 解析后的命令参数 */
interface CommandParams {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  readonly failOnNonZero: boolean;
  readonly retry: RetryOptions | undefined;
  /** v0.4.2：true 时执行前抛 ReviewRequiredError 待人工审核（AI 生成命令默认开启） */
  readonly reviewRequired: boolean;
  /** v0.4.2：命令生成来源（"ai"=AI 生成；缺省/undefined=无标记） */
  readonly generatedBy: "ai" | "manual" | undefined;
}

/** 命令执行结果 */
interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 解析 retry 配置：缺省返回 undefined（不重试）；结构非法返回 undefined（走参数错误）。 */
function parseRetry(raw: unknown): RetryOptions | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const attempts = record["attempts"];
  if (attempts !== undefined && typeof attempts !== "number") {
    return undefined;
  }
  const delayMs = record["delayMs"];
  if (delayMs !== undefined && typeof delayMs !== "number") {
    return undefined;
  }
  return {
    attempts: attempts === undefined ? undefined : attempts,
    delayMs: delayMs === undefined ? 100 : delayMs,
  };
}

/** 解析有效重试次数：attempts 缺省 → 0（不重试，总执行 1 次）。 */
function resolveRetryAttempts(retry: RetryOptions | undefined): number {
  if (retry === undefined || retry.attempts === undefined) {
    return 0;
  }
  return Math.max(0, Math.floor(retry.attempts));
}

/** 瞬时类错误才重试：超时 / 非零退出（后者仅在 failOnNonZero=true 时抛出）；参数错误在解析期抛出，不进循环。 */
function isTransientError(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof NonZeroExitError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 边界解析：从未知参数记录解析命令参数，非法返回 undefined */
function parseParams(params: Readonly<Record<string, unknown>>): CommandParams | undefined {
  const command = params["command"];
  if (typeof command !== "string") {
    return undefined;
  }
  const args = params["args"];
  if (args !== undefined && !isStringArray(args)) {
    return undefined;
  }
  const cwd = params["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") {
    return undefined;
  }
  const timeoutMs = params["timeoutMs"];
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    return undefined;
  }
  const failOnNonZero = params["failOnNonZero"];
  if (failOnNonZero !== undefined && typeof failOnNonZero !== "boolean") {
    return undefined;
  }
  const retry = parseRetry(params["retry"]);
  if (retry === undefined && params["retry"] !== undefined) {
    return undefined;
  }
  const reviewRequired = params["reviewRequired"];
  if (reviewRequired !== undefined && typeof reviewRequired !== "boolean") {
    return undefined;
  }
  const generatedBy = params["generatedBy"];
  if (generatedBy !== undefined && generatedBy !== "ai" && generatedBy !== "manual") {
    return undefined;
  }
  return {
    command,
    args: args === undefined ? [] : args,
    cwd: cwd === undefined ? undefined : cwd,
    timeoutMs: timeoutMs === undefined ? 30000 : timeoutMs,
    failOnNonZero: failOnNonZero === undefined ? false : failOnNonZero,
    retry,
    reviewRequired: reviewRequired === undefined ? false : reviewRequired,
    generatedBy: generatedBy === undefined ? undefined : generatedBy,
  };
}

/** 运行命令：超时 kill 并抛 TimeoutError；cwd 为沙箱解析后工作目录（undefined=引擎当前目录）。 */
async function runCommand(params: CommandParams, cwd: string | undefined): Promise<CommandResult> {
  const proc = Bun.spawn([params.command, ...params.args], {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      proc.kill();
      reject(new TimeoutError(params.command, params.timeoutMs));
    }, params.timeoutMs);
  });

  try {
    const [stdout, stderr] = await Promise.race([output, timeout]);
    const exitCode = await proc.exited;
    if (params.failOnNonZero && exitCode !== 0) {
      throw new NonZeroExitError(params.command, exitCode, stderr);
    }
    return { stdout, stderr, exitCode };
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

export const commandNode: INodeDefinition = {
  type: "command",
  name: "命令行执行",
  paramsSchema: [
    { key: "command", label: "命令", type: "textarea", required: true, placeholder: "如 echo hello" },
    { key: "args", label: "参数数组", type: "json", default: [], description: "追加到命令后的参数列表" },
    { key: "cwd", label: "工作目录", type: "string", placeholder: "缺省使用引擎当前工作目录" },
    { key: "timeoutMs", label: "超时（毫秒）", type: "number", default: 30000 },
    { key: "failOnNonZero", label: "非零退出码视为失败", type: "boolean", default: false },
    { key: "retry", label: "重试配置", type: "json", description: "{ attempts?: number, delayMs?: number }；缺省不重试" },
    { key: "reviewRequired", label: "需要人工审核", type: "boolean", default: false, description: "执行前暂停等待人工批准（AI 生成命令默认开启）" },
    { key: "generatedBy", label: "生成来源", type: "select", default: "manual", options: [{ label: "人工", value: "manual" }, { label: "AI", value: "ai" }] },
  ],
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
  async execute(ctx) {
    const params = parseParams(ctx.node.params);
    if (params === undefined) {
      throw new InvalidCommandParamsError(ctx.node.params);
    }
    // 安全护栏（v0.4.2）：黑名单命中立即抛；reviewRequired 未批准抛 ReviewRequiredError（重写 nodeId 供引擎桥接挂起）。
    // 已批准放行（v0.4.2 验收 2）：reviewApprovals 含本节点 → 以 reviewRequired=false 调用，黑名单检查始终生效。
    const approved = params.reviewRequired === true && ctx.reviewApprovals?.has(ctx.node.id) === true;
    try {
      checkCommandSafety(params.command, approved ? false : params.reviewRequired);
    } catch (error) {
      if (error instanceof ReviewRequiredError) {
        throw new ReviewRequiredError(ctx.node.id, error.description);
      }
      throw error;
    }
    // 沙箱（v0.9.4）：配置 sandboxRootDir 时 cwd 缺省强制沙箱根；显式 cwd 必须解析在沙箱内（逃逸拒绝）。
    const sandboxRoot = ctx.sandboxRootDir;
    let effectiveCwd: string | undefined;
    if (sandboxRoot === undefined) {
      effectiveCwd = params.cwd;
    } else if (params.cwd === undefined) {
      effectiveCwd = sandboxRoot;
    } else {
      const resolved = resolveSandboxPath(sandboxRoot, params.cwd);
      if (resolved === undefined) {
        throw new SandboxPathError(sandboxRoot, params.cwd);
      }
      effectiveCwd = resolved;
    }
    const attempts = resolveRetryAttempts(params.retry);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await runCommand(params, effectiveCwd);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (error) {
        // 达到重试上限或非瞬时错误：立即抛出；每次重试前重新 spawn（全新子进程）。
        if (attempt >= attempts || !isTransientError(error)) {
          throw error;
        }
        await sleep(params.retry?.delayMs ?? 100);
      }
    }
  },
};
