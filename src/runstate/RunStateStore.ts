// RunState 断点 JSON 文件持久化：懒加载 + 原子写入（公共 atomicWriteFile）。
// 注意：createIfAbsent（幂等注册）为先查后建——非原子，仅单进程可用；多进程判重须用 SQLite 版（唯一索引原子约束）。
import { readFile } from "node:fs/promises";
import type { RunState } from "./types.js";
import type { RunStateStoreLike } from "../db/stores/types.js";
import { atomicWriteFile } from "../storage/atomic.js";

/** 指定 runId 的断点状态不存在。 */
export class RunStateNotFoundError extends Error {
  readonly name = "RunStateNotFoundError";

  constructor(readonly runId: string) {
    super(`run state not found: "${runId}"`);
  }
}

/** JSON 文件损坏（解析失败或结构不符）。 */
export class RunStateCorruptedError extends Error {
  readonly name = "RunStateCorruptedError";

  constructor(
    readonly filePath: string,
    readonly reason: unknown,
  ) {
    super(`run state store corrupted: "${filePath}" (${describeError(reason)})`);
  }
}

interface RunStatePayload {
  readonly runs: readonly RunState[];
}

export class RunStateStore implements RunStateStoreLike {
  private runs: readonly RunState[] = [];
  private loaded = false;
  private readonly filePath: string;

  constructor(options: { readonly filePath?: string } = {}) {
    this.filePath = options.filePath ?? "run_states.json";
  }

  /** 写入断点：同 runId 已存在则覆盖更新（upsert 语义），不存在则追加。 */
  async create(run: RunState): Promise<void> {
    await this.ensureLoaded();
    this.runs = this.runs.some((existing) => existing.runId === run.runId)
      ? this.runs.map((existing) => (existing.runId === run.runId ? run : existing))
      : [...this.runs, run];
    await this.save();
  }

  /** 同 create，upsert 语义。 */
  async update(run: RunState): Promise<void> {
    await this.create(run);
  }

  /**
   * 先查后建（v0.2.5 T2）：同 runId 或同 (workflowId+idempotencyKey) 记录已存在 → 返回 false 不写入；
   * 否则追加并落盘返回 true。非原子，仅单进程可用。
   */
  async createIfAbsent(run: RunState): Promise<boolean> {
    await this.ensureLoaded();
    const conflict = run.idempotencyKey === undefined
      ? this.runs.some((existing) => existing.runId === run.runId)
      : this.runs.some((existing) =>
          existing.runId === run.runId || (existing.workflowId === run.workflowId && existing.idempotencyKey === run.idempotencyKey),
        );
    if (conflict) {
      return false;
    }
    this.runs = [...this.runs, run];
    await this.save();
    return true;
  }

  async getById(runId: string): Promise<RunState | undefined> {
    await this.ensureLoaded();
    return this.runs.find((run) => run.runId === runId);
  }

  async list(): Promise<RunState[]> {
    await this.ensureLoaded();
    return [...this.runs];
  }

  async listByWorkflow(workflowId: string): Promise<RunState[]> {
    await this.ensureLoaded();
    return this.runs.filter((run) => run.workflowId === workflowId);
  }

  /** 按运行状态过滤（调试 CLI 用：paused 等 v0.2.4 新状态可查）。 */
  async listByStatus(status: RunState["status"]): Promise<RunState[]> {
    await this.ensureLoaded();
    return this.runs.filter((run) => run.status === status);
  }

  /** 显式落盘：公共 atomicWriteFile 写 tmp → 读回 JSON.parse 校验 → rename 原子替换。 */
  async save(): Promise<void> {
    await this.ensureLoaded(); // 防止用未加载的空状态覆盖已有文件
    await atomicWriteFile(
      this.filePath,
      `${JSON.stringify({ runs: this.runs }, null, 2)}\n`,
      (text) => JSON.parse(text),
    );
  }

  /** 显式重载：文件不存在返回空列表；JSON 损坏抛 RunStateCorruptedError。 */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (getErrnoCode(error) === "ENOENT") {
        this.runs = [];
        this.loaded = true;
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new RunStateCorruptedError(this.filePath, error);
    }
    if (!isRunStatePayload(parsed)) {
      throw new RunStateCorruptedError(this.filePath, new Error('expected { "runs": RunState[] }'));
    }
    this.runs = parsed.runs;
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }
}

function isRunStatePayload(value: unknown): value is RunStatePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "runs" in value &&
    Array.isArray(value.runs)
  );
}

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 提取错误的可读消息。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
