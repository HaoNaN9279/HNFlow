// 命令行执行节点：Bun.spawn 运行外部命令，捕获 stdout/stderr 与退出码。

import type { INodeDefinition } from "../execution/types.js";

/** command 节点参数格式非法 */
export class InvalidCommandParamsError extends Error {
  readonly name = "InvalidCommandParamsError";

  constructor(readonly params: unknown) {
    super(
      "invalid command params: expected { command: string, args?, cwd?, timeoutMs?, failOnNonZero? }",
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

/** 解析后的命令参数 */
interface CommandParams {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  readonly failOnNonZero: boolean;
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
  return {
    command,
    args: args === undefined ? [] : args,
    cwd: cwd === undefined ? undefined : cwd,
    timeoutMs: timeoutMs === undefined ? 30000 : timeoutMs,
    failOnNonZero: failOnNonZero === undefined ? false : failOnNonZero,
  };
}

/** 运行命令：超时 kill 并抛 TimeoutError */
async function runCommand(params: CommandParams): Promise<CommandResult> {
  const proc = Bun.spawn([params.command, ...params.args], {
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
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
    const result = await runCommand(params);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
};
