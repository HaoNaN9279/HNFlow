// HumanTask SQLite 持久化：状态迁移语义对齐 JSON 版（src/human/HumanTaskStore.ts），复用其 InvalidTaskStateError。
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../index.js";
import { openDatabase } from "../index.js";
import { InvalidTaskStateError } from "../../human/HumanTaskStore.js";
import type { HumanTask, HumanTaskSpec } from "../../human/types.js";
import type { HumanTaskStoreLike } from "./types.js";
import { parseTaskRow } from "./humanTaskParse.js";

export class SqliteHumanTaskStore implements HumanTaskStoreLike {
  private db: SqliteDatabase | undefined;
  private readonly dbPath: string;
  private readonly sharedDb: SqliteDatabase | undefined;

  /**
   * @param sharedDb 可选共享连接：传入后复用其 db（不自行 openDatabase/ensureSchema/close），
   * 由共享方负责建表与关闭；缺省则维持独立连接行为（懒打开 + 自动建表）。
   */
  constructor(dbPath: string, sharedDb?: SqliteDatabase) {
    this.dbPath = dbPath;
    this.sharedDb = sharedDb;
  }

  /** 创建人工任务：randomUUID 生成 id，默认 status=pending、fallback=manual。 */
  async create(
    spec: HumanTaskSpec & { readonly workflowId: string; readonly nodeId: string; readonly nodeName: string },
  ): Promise<HumanTask> {
    const db = await this.ensureOpened();
    const id = randomUUID();
    const createdAt = Date.now();
    const fallback = spec.fallback ?? "manual";
    db.db.prepare(
      `INSERT INTO human_tasks (id, workflow_id, node_id, node_name, title, status, description, meta, result, fallback, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      spec.workflowId,
      spec.nodeId,
      spec.nodeName,
      spec.title,
      "pending",
      spec.description === undefined ? null : spec.description,
      spec.meta === undefined ? null : JSON.stringify(spec.meta),
      null,
      fallback,
      createdAt,
      null,
    );
    return {
      id,
      workflowId: spec.workflowId,
      nodeId: spec.nodeId,
      nodeName: spec.nodeName,
      title: spec.title,
      status: "pending",
      fallback,
      createdAt,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.meta === undefined ? {} : { meta: spec.meta }),
    };
  }

  async listAll(): Promise<HumanTask[]> {
    const db = await this.ensureOpened();
    return db.db.prepare("SELECT * FROM human_tasks ORDER BY created_at, id").all().map(parseTaskRow);
  }

  async listPending(): Promise<HumanTask[]> {
    const db = await this.ensureOpened();
    return db.db.prepare("SELECT * FROM human_tasks WHERE status = 'pending' ORDER BY created_at, id").all().map(parseTaskRow);
  }

  async getById(id: string): Promise<HumanTask | undefined> {
    const db = await this.ensureOpened();
    const row = db.db.prepare("SELECT * FROM human_tasks WHERE id = ?").get(id);
    return row === undefined ? undefined : parseTaskRow(row);
  }

  /** 查找指定 workflow+node 的待处理任务（引擎挂起前查重用）。 */
  async findPending(workflowId: string, nodeId: string): Promise<HumanTask | undefined> {
    const db = await this.ensureOpened();
    const row = db.db.prepare(
      "SELECT * FROM human_tasks WHERE workflow_id = ? AND node_id = ? AND status = 'pending' LIMIT 1",
    ).get(workflowId, nodeId);
    return row === undefined ? undefined : parseTaskRow(row);
  }

  /** 查找指定 workflow+node 最近创建的任务（任意状态；AI 多轮中断复用任务用）。 */
  async findRecent(workflowId: string, nodeId: string): Promise<HumanTask | undefined> {
    const db = await this.ensureOpened();
    const row = db.db.prepare(
      "SELECT * FROM human_tasks WHERE workflow_id = ? AND node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(workflowId, nodeId);
    return row === undefined ? undefined : parseTaskRow(row);
  }

  /** 完成：仅 pending 可迁移，写入 completedAt + result；否则抛 InvalidTaskStateError。 */
  async complete(id: string, result?: unknown): Promise<HumanTask> {
    const db = await this.ensureOpened();
    const changes = db.db.prepare(
      "UPDATE human_tasks SET status = 'completed', completed_at = ?, result = ? WHERE id = ? AND status = 'pending'",
    ).run(Date.now(), result === undefined ? null : JSON.stringify(result), id).changes;
    return this.requireTransitioned(id, changes);
  }

  /** 跳过：仅 pending 可迁移。 */
  async skip(id: string): Promise<HumanTask> {
    const db = await this.ensureOpened();
    const changes = db.db.prepare(
      "UPDATE human_tasks SET status = 'skipped', completed_at = ? WHERE id = ? AND status = 'pending'",
    ).run(Date.now(), id).changes;
    return this.requireTransitioned(id, changes);
  }

  /** 延后：仅 pending 可迁移。 */
  async defer(id: string): Promise<HumanTask> {
    const db = await this.ensureOpened();
    const changes = db.db.prepare(
      "UPDATE human_tasks SET status = 'deferred', completed_at = ? WHERE id = ? AND status = 'pending'",
    ).run(Date.now(), id).changes;
    return this.requireTransitioned(id, changes);
  }

  /** 回退已完成任务到 pending：仅 completed 可迁移；result 列不动（AC4 不丢用户输入）；meta 可选覆盖。
   *  恢复失败回退后重试可直接复用原 result；多轮中断时用 meta 更新最新 checkpoint 上下文。 */
  async reopen(id: string, meta?: Readonly<Record<string, unknown>>): Promise<HumanTask> {
    const db = await this.ensureOpened();
    const changes = meta === undefined
      ? db.db.prepare(
          "UPDATE human_tasks SET status = 'pending', completed_at = NULL WHERE id = ? AND status = 'completed'",
        ).run(id).changes
      : db.db.prepare(
          "UPDATE human_tasks SET status = 'pending', completed_at = NULL, meta = ? WHERE id = ? AND status = 'completed'",
        ).run(JSON.stringify(meta), id).changes;
    return this.requireTransitioned(id, changes);
  }

  /** 关闭连接；重复 close 幂等。共享连接不关闭（由共享方负责）。 */
  async close(): Promise<void> {
    if (this.sharedDb !== undefined) {
      return;
    }
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
  }

  private async ensureOpened(): Promise<SqliteDatabase> {
    if (this.sharedDb !== undefined) {
      return this.sharedDb;
    }
    if (this.db === undefined) {
      const db = await openDatabase(this.dbPath);
      db.ensureSchema();
      this.db = db;
    }
    return this.db;
  }

  /** 迁移后校验：0 行（未找到或非 pending）抛 InvalidTaskStateError，否则读回最新行。 */
  private async requireTransitioned(id: string, changes: number): Promise<HumanTask> {
    if (changes === 0) {
      const current = await this.getById(id);
      throw new InvalidTaskStateError(id, current?.status ?? "not found");
    }
    const updated = await this.getById(id);
    if (updated === undefined) {
      throw new Error(`human task not found after update: "${id}"`);
    }
    return updated;
  }
}
