// SqliteCheckpointSaver：LangGraph checkpoint 持久化到 SQLite（v0.2.1 AI 中断持久化）。
// 与 HumanTask/RunState 同库同连接（sharedDb 注入，可同事务）；本类只做单条 SQL 写、
// 不主动 begin/commit——事务边界由调用方控制（T5 引擎"三写同事务"的前提）。
import { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } from "@langchain/langgraph-checkpoint";
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { SqliteBindValue, SqliteRow } from "../db/adapter.js";
import { openDatabase, type SqliteDatabase } from "../db/index.js";

/**
 * BaseCheckpointSaver 的 SQLite 实现，读写 checkpoints / checkpoint_writes 两表
 * （T2 schema 已建，列结构见 src/db/schema.ts）。
 * 表列对齐：serde.dumpsTyped 的 [type, bytes] 分别存 type 列与 checkpoint/blob 列；
 * checkpoint 用 type 列反序列化，metadata 恒为 "json"（普通对象不会走 "bytes" 分支）。
 */
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private db: SqliteDatabase | undefined;
  private readonly dbPath: string;
  private readonly sharedDb: SqliteDatabase | undefined;

  /**
   * @param dbPath 数据库文件路径（注入 sharedDb 时也须传，对齐 T2 store 构造签名）。
   * @param sharedDb 可选共享连接：传入后复用其 db 连接与 schema（不自行 open/ensure/close），
   * 由共享方负责建表与关闭；缺省则维持独立连接行为（懒打开 + 自动建表）。
   */
  constructor(dbPath: string, sharedDb?: SqliteDatabase) {
    super(); // 缺省 serde = JsonPlusSerializer（官方，支持 LangChain 对象序列化）
    this.dbPath = dbPath;
    this.sharedDb = sharedDb;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const db = await this.ensureOpened();
    const threadId = requireThreadId(config, "getTuple");
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = getCheckpointId(config);
    const row =
      checkpointId === ""
        ? db.db.prepare(
            "SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1",
          ).get(threadId, checkpointNs)
        : db.db.prepare(
            "SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
          ).get(threadId, checkpointNs, checkpointId);
    if (row === undefined) {
      return undefined;
    }
    const resolvedId = checkpointId === "" ? requireString(row, "checkpoint_id") : checkpointId;
    // 未指定 checkpoint_id（取最新）时返回含 checkpoint_id 的新 config，语义对齐 MemorySaver。
    const tupleConfig: RunnableConfig =
      checkpointId === ""
        ? { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: resolvedId } }
        : config;
    return this.buildTuple(db, tupleConfig, row);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const db = await this.ensureOpened();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const configCheckpointId = config.configurable?.checkpoint_id;
    const before = options?.before?.configurable?.checkpoint_id;
    const filter = options?.filter;
    const limit = options?.limit;

    const clauses: string[] = [];
    const params: SqliteBindValue[] = [];
    if (typeof threadId === "string") {
      clauses.push("thread_id = ?");
      params.push(threadId);
    }
    if (typeof checkpointNs === "string") {
      clauses.push("checkpoint_ns = ?");
      params.push(checkpointNs);
    }
    if (typeof configCheckpointId === "string") {
      clauses.push("checkpoint_id = ?");
      params.push(configCheckpointId);
    }
    if (typeof before === "string") {
      clauses.push("checkpoint_id < ?");
      params.push(before);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = db.db.prepare(`SELECT * FROM checkpoints${where} ORDER BY checkpoint_id DESC`).all(...params);

    // filter 需反序列化 metadata 后才可判断，故不依赖 SQL LIMIT——JS 侧过滤后计数，语义与 MemorySaver.list 一致。
    let remaining = limit;
    for (const row of rows) {
      const metadata = await this.serde.loadsTyped("json", requireBytes(row, "metadata"));
      if (filter !== undefined && !Object.entries(filter).every(([key, value]) => metadata[key] === value)) {
        continue;
      }
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      const rowThreadId = requireString(row, "thread_id");
      const rowNs = requireString(row, "checkpoint_ns");
      const rowCheckpointId = requireString(row, "checkpoint_id");
      yield await this.buildTuple(
        db,
        { configurable: { thread_id: rowThreadId, checkpoint_ns: rowNs, checkpoint_id: rowCheckpointId } },
        row,
      );
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const db = await this.ensureOpened();
    const threadId = requireThreadId(config, "put");
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [checkpointSer, metadataSer] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    db.db.prepare(
      `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId,
      checkpointNs,
      preparedCheckpoint.id,
      config.configurable?.checkpoint_id ?? null,
      checkpointSer[0],
      checkpointSer[1],
      metadataSer[1],
      Date.now(),
    );
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: preparedCheckpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const db = await this.ensureOpened();
    const threadId = requireThreadId(config, "putWrites");
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string" || checkpointId === "") {
      throw new Error("putWrites 需要 config.configurable.checkpoint_id（写入须关联具体 checkpoint）");
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const stmt = db.db.prepare(
      `INSERT OR REPLACE INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [idx, write] of writes.entries()) {
      const [channel, value] = write;
      const [type, blob] = await this.serde.dumpsTyped(value);
      // 特殊 channel（错误/中断等）用 WRITES_IDX_MAP 负索引，避免与普通写冲突。
      stmt.run(threadId, checkpointNs, checkpointId, taskId, WRITES_IDX_MAP[channel] ?? idx, channel, type, blob);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = await this.ensureOpened();
    db.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
    db.db.prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(threadId);
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

  /** 由 checkpoints 行构造 CheckpointTuple：反序列化 + pendingWrites（task_id, idx 序）+ parentConfig。 */
  private async buildTuple(db: SqliteDatabase, tupleConfig: RunnableConfig, row: SqliteRow): Promise<CheckpointTuple> {
    const checkpoint = await this.serde.loadsTyped(serializeTypeOf(row), requireBytes(row, "checkpoint"));
    const metadata = await this.serde.loadsTyped("json", requireBytes(row, "metadata"));
    const threadId = requireString(row, "thread_id");
    const checkpointNs = requireString(row, "checkpoint_ns");
    const checkpointId = requireString(row, "checkpoint_id");
    const writeRows = db.db.prepare(
      "SELECT task_id, channel, type, blob FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx",
    ).all(threadId, checkpointNs, checkpointId);
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const writeRow of writeRows) {
      pendingWrites.push([
        requireString(writeRow, "task_id"),
        requireString(writeRow, "channel"),
        await this.serde.loadsTyped(requireString(writeRow, "type") || "json", requireBytes(writeRow, "blob")),
      ]);
    }
    const tuple: CheckpointTuple = { config: tupleConfig, checkpoint, metadata, pendingWrites };
    const parentId = row.parent_checkpoint_id;
    if (typeof parentId === "string" && parentId !== "") {
      tuple.parentConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: parentId },
      };
    }
    return tuple;
  }
}

/** 从 config.configurable 提取 thread_id；缺失/非字符串抛中文错误。 */
function requireThreadId(config: RunnableConfig, method: string): string {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId === "") {
    throw new Error(`${method} 需要 config.configurable.thread_id（checkpointer 必须传 thread_id 以定位持久化线程）`);
  }
  return threadId;
}

/** 行中字符串列读取：类型校验，失败抛中文错误。 */
function requireString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`checkpoints.${column} 应为字符串，实际为 ${describeValue(value)}`);
  }
  return value;
}

/** 行中 BLOB 列读取：SQLite BLOB 由两驱动返回 Uint8Array；否则抛中文错误。 */
function requireBytes(row: SqliteRow, column: string): Uint8Array {
  const value = row[column];
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new Error(`checkpoints.${column} 应为字节数组，实际为 ${describeValue(value)}`);
}

/** checkpoints 行 type 列：空串（表默认值）回退 "json"。 */
function serializeTypeOf(row: SqliteRow): string {
  return requireString(row, "type") || "json";
}

function describeValue(value: unknown): string {
  return value === null ? "null" : typeof value;
}
