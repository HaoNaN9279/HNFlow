// RunState 断点 JSON 文件持久化：懒加载 + 原子写入（tmp 读回校验 + rename 替换）。
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunState } from "./types.js";

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

export class RunStateStore {
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

  /** 显式落盘：tmp 写入 → 读回 JSON.parse 校验 → rename 原子替换。 */
  async save(): Promise<void> {
    await this.ensureLoaded(); // 防止用未加载的空状态覆盖已有文件
    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(tmpPath, `${JSON.stringify({ runs: this.runs }, null, 2)}\n`, "utf8");
      const written = await readFile(tmpPath, "utf8");
      JSON.parse(written); // 完整性校验：可解析即认为写入完整
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await removeTmpQuietly(tmpPath);
      throw error;
    }
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

/** 尽力清理残留 tmp；不存在则忽略，其他清理失败也不掩盖原始错误。 */
async function removeTmpQuietly(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return; // 从未创建或已清理
    // no-excuse-ok: catch — 清理失败不影响原始错误的抛出
  }
}

/** 提取错误的可读消息。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
