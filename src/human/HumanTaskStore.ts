// 人工任务 JSON 文件持久化：懒加载 + 原子写入（公共 atomicWriteFile）。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HumanTask, HumanTaskSpec, HumanTaskStatus } from "./types.js";
import type { HumanTaskStoreLike } from "../db/stores/types.js";
import { atomicWriteFile } from "../storage/atomic.js";

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

export class HumanTaskStore implements HumanTaskStoreLike {
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

  /** 查找指定 workflow+node 的待处理任务（引擎挂起前查重用）。 */
  async findPending(workflowId: string, nodeId: string): Promise<HumanTask | undefined> {
    await this.ensureLoaded();
    return this.tasks.find((t) => t.status === "pending" && t.workflowId === workflowId && t.nodeId === nodeId);
  }

  /** 查找指定 workflow+node 最近创建的任务（任意状态；tasks 按创建序追加，取最后一个匹配）。 */
  async findRecent(workflowId: string, nodeId: string): Promise<HumanTask | undefined> {
    await this.ensureLoaded();
    let recent: HumanTask | undefined;
    for (const task of this.tasks) {
      if (task.workflowId === workflowId && task.nodeId === nodeId) recent = task;
    }
    return recent;
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

  /** 回退已完成任务到 pending：仅 completed 可回退；result 保留（AC4 不丢用户输入）；meta 可选覆盖。
   *  恢复失败回退后重试可直接复用原 result；多轮中断时用 meta 更新最新 checkpoint 上下文。 */
  async reopen(id: string, meta?: Readonly<Record<string, unknown>>): Promise<HumanTask> {
    return this.transition(id, "completed", (task) => ({
      id: task.id,
      workflowId: task.workflowId,
      nodeId: task.nodeId,
      nodeName: task.nodeName,
      title: task.title,
      status: "pending",
      fallback: task.fallback,
      createdAt: task.createdAt,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(meta === undefined ? (task.meta === undefined ? {} : { meta: task.meta }) : { meta }),
      ...(task.result === undefined ? {} : { result: task.result }),
    }));
  }

  /** 显式落盘：公共 atomicWriteFile 写 tmp → 读回 JSON.parse 校验 → rename 原子替换。 */
  async save(): Promise<void> {
    await this.ensureLoaded(); // 防止用未加载的空状态覆盖已有文件
    await atomicWriteFile(
      this.filePath,
      `${JSON.stringify({ tasks: this.tasks }, null, 2)}\n`,
      (text) => JSON.parse(text),
    );
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

/** 提取错误的可读消息。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
