// 人工任务 JSON 文件持久化：懒加载 + 原子写入（tmp 读回校验 + rename 替换）。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HumanTask, HumanTaskSpec, HumanTaskStatus } from "./types.js";

/** 任务不存在或状态不允许该操作（如 complete 一个已 skipped 的任务）。 */
export class InvalidTaskStateError extends Error {
  readonly name = "InvalidTaskStateError";

  constructor(
    readonly taskId: string,
    readonly currentStatus: string,
  ) {
    super(`task "${taskId}" cannot be modified: current status is "${currentStatus}"`);
  }
}

/** JSON 文件损坏（解析失败或结构不符）。 */
export class TaskStoreCorruptedError extends Error {
  readonly name = "TaskStoreCorruptedError";

  constructor(
    readonly filePath: string,
    readonly reason: unknown,
  ) {
    super(`human task store corrupted: "${filePath}" (${describeError(reason)})`);
  }
}

interface TasksPayload {
  readonly tasks: readonly HumanTask[];
}

export class HumanTaskStore {
  private tasks: readonly HumanTask[] = [];
  private loaded = false;
  private readonly filePath: string;

  constructor(options: { readonly filePath?: string } = {}) {
    this.filePath = options.filePath ?? "human_tasks.json";
  }

  async create(spec: HumanTaskSpec & { readonly workflowId: string; readonly nodeId: string; readonly nodeName: string }): Promise<HumanTask> {
    await this.ensureLoaded();
    const task: HumanTask = {
      id: randomUUID(),
      workflowId: spec.workflowId,
      nodeId: spec.nodeId,
      nodeName: spec.nodeName,
      title: spec.title,
      status: "pending",
      fallback: spec.fallback ?? "manual",
      createdAt: Date.now(),
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.meta === undefined ? {} : { meta: spec.meta }),
    };
    this.tasks = [...this.tasks, task];
    await this.save();
    return task;
  }

  async listAll(): Promise<HumanTask[]> {
    await this.ensureLoaded();
    return [...this.tasks].sort((a, b) => a.createdAt - b.createdAt);
  }

  async listPending(): Promise<HumanTask[]> {
    await this.ensureLoaded();
    return this.tasks
      .filter((task) => task.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getById(id: string): Promise<HumanTask | undefined> {
    await this.ensureLoaded();
    return this.tasks.find((task) => task.id === id);
  }

  async complete(id: string, result?: unknown): Promise<HumanTask> {
    return this.transition(id, "pending", (task) => ({
      ...task,
      status: "completed",
      completedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
    }));
  }

  async skip(id: string): Promise<HumanTask> {
    return this.transition(id, "pending", (task) => ({
      ...task,
      status: "skipped",
      completedAt: Date.now(),
    }));
  }

  async defer(id: string): Promise<HumanTask> {
    return this.transition(id, "pending", (task) => ({
      ...task,
      status: "deferred",
      completedAt: Date.now(),
    }));
  }

  /** 显式落盘：tmp 写入 → 读回 JSON.parse 校验 → rename 原子替换。 */
  async save(): Promise<void> {
    await this.ensureLoaded(); // 防止用未加载的空状态覆盖已有文件
    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(tmpPath, `${JSON.stringify({ tasks: this.tasks }, null, 2)}\n`, "utf8");
      const written = await readFile(tmpPath, "utf8");
      JSON.parse(written); // 完整性校验：可解析即认为写入完整
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await removeTmpQuietly(tmpPath);
      throw error;
    }
  }

  /** 显式重载：文件不存在返回空列表；JSON 损坏抛 TaskStoreCorruptedError。 */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (getErrnoCode(error) === "ENOENT") {
        this.tasks = [];
        this.loaded = true;
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new TaskStoreCorruptedError(this.filePath, error);
    }
    if (!isTasksPayload(parsed)) {
      throw new TaskStoreCorruptedError(this.filePath, new Error('expected { "tasks": HumanTask[] }'));
    }
    this.tasks = parsed.tasks;
    this.loaded = true;
  }

  /** 校验任务存在且处于起始状态，执行迁移并落盘。 */
  private async transition(
    id: string,
    fromStatus: HumanTaskStatus,
    next: (task: HumanTask) => HumanTask,
  ): Promise<HumanTask> {
    await this.ensureLoaded();
    const current = this.tasks.find((task) => task.id === id);
    if (current === undefined || current.status !== fromStatus) {
      throw new InvalidTaskStateError(id, current?.status ?? "not found");
    }
    const updated = next(current);
    this.tasks = this.tasks.map((task) => (task.id === id ? updated : task));
    await this.save();
    return updated;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }
}

function isTasksPayload(value: unknown): value is TasksPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "tasks" in value &&
    Array.isArray(value.tasks)
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
