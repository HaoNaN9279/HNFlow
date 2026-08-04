// ExecutionLog 持久化存储：SQLite 批量缓冲写入——append 同步入内存（不阻塞调用方），
// flush 异步单事务落库（全部成功才提交，失败保留缓冲可重试）；autoFlushMs 定时自动 flush。
// 行为约定：list() 按 created_at 升序（同刻按 id 稳定）；listRecent() 按 created_at 降序返回最近 N 条；
// close() 之后 append/flush/list 均抛 ExecutionLogError。
import { randomUUID } from "node:crypto";
import { openDatabase, type SqliteDatabase } from "../db/index.js";
import type { SqliteBindValue, SqliteRow } from "../db/adapter.js";
import { ExecutionLogError, type ExecutionLogEntry, type ExecutionLogQuery, type LogLevel } from "./types.js";

export { ExecutionLogError } from "./types.js";
export type { ExecutionLogEntry, ExecutionLogQuery, LogLevel } from "./types.js";

/** 写日志 INSERT（列序与条目字段一一对应，data 为 JSON 字符串或 NULL）。 */
const INSERT_LOG_SQL =
  "INSERT INTO execution_logs (id, run_id, workflow_id, node_id, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/** 查询列清单（读回时 rowToEntry 反序列化）。 */
const SELECT_LOG_COLUMNS = "id, run_id, workflow_id, node_id, level, message, data, created_at";

export class ExecutionLogStore {
  private readonly dbPath: string;
  /** 构造即启动的 db 打开 + 建表流程；所有 async 操作先 await 它。 */
  private readonly initPromise: Promise<SqliteDatabase>;
  /** 内存缓冲：append 同步追加，flush 时整批取走。 */
  private buffer: ExecutionLogEntry[] = [];
  /** autoFlush 定时器（仅在传入 autoFlushMs 时存在）。 */
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private closed = false;

  constructor(dbPath: string, options: { readonly autoFlushMs?: number } = {}) {
    this.dbPath = dbPath;
    this.initPromise = this.init();
    const autoFlushMs = options.autoFlushMs;
    if (autoFlushMs !== undefined) {
      this.timer = setInterval(() => {
        // 自动 flush：失败保留缓冲，下一轮自动重试
        void this.flush().catch(() => {});
      }, autoFlushMs);
      this.timer.unref(); // 不阻止进程退出
    }
  }

  /** 追加一条日志到内存缓冲（同步返回，不落库）；落库需 flush 或等待 autoFlush。 */
  append(entry: ExecutionLogEntry): void {
    this.assertOpen();
    this.buffer.push(this.normalize(entry));
  }

  /** 将缓冲整批写入 SQLite；无缓冲时直接返回。 */
  async flush(): Promise<void> {
    this.assertOpen();
    const handle = await this.initPromise;
    const pending = this.takeBuffer();
    if (pending.length === 0) return;
    this.writeBatch(handle, pending);
  }

  /** 按条件过滤查询（未 flush 的缓冲不计入）；created_at 升序，同刻按 id 稳定。 */
  async list(query: ExecutionLogQuery = {}): Promise<ExecutionLogEntry[]> {
    this.assertOpen();
    const handle = await this.initPromise;
    const { whereSql, params } = buildWhere(query);
    const limitSql = query.limit === undefined ? "" : " LIMIT ?";
    if (query.limit !== undefined) params.push(query.limit);
    const sql = `SELECT ${SELECT_LOG_COLUMNS} FROM execution_logs${whereSql} ORDER BY created_at ASC, id ASC${limitSql}`;
    const rows = handle.db.prepare(sql).all(...params);
    return rows.map((row) => rowToEntry(row));
  }

  /** 便捷查询：按 runId 过滤（升序）。 */
  listByRun(runId: string): Promise<ExecutionLogEntry[]> {
    return this.list({ runId });
  }

  /** 便捷查询：按 workflowId 过滤（升序）。 */
  listByWorkflow(workflowId: string): Promise<ExecutionLogEntry[]> {
    return this.list({ workflowId });
  }

  /** 便捷查询：按 nodeId 过滤（升序）。 */
  listByNode(nodeId: string): Promise<ExecutionLogEntry[]> {
    return this.list({ nodeId });
  }

  /** 便捷查询：返回最近 limit 条，created_at 降序（最新在前）。 */
  async listRecent(limit: number): Promise<ExecutionLogEntry[]> {
    this.assertOpen();
    const handle = await this.initPromise;
    const sql = `SELECT ${SELECT_LOG_COLUMNS} FROM execution_logs ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = handle.db.prepare(sql).all(limit);
    return rows.map((row) => rowToEntry(row));
  }

  /** 关闭：flush 剩余缓冲并关闭 db；此后任何操作抛 ExecutionLogError。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; // 防重入；后续直接走内部写路径，不再过 assertOpen
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const handle = await this.initPromise; // init 失败时抛 ExecutionLogError
    try {
      const pending = this.takeBuffer();
      if (pending.length > 0) {
        this.writeBatch(handle, pending);
      }
    } finally {
      handle.close();
    }
  }

  /** 打开 db 并幂等建表；失败抛 ExecutionLogError（已打开则关闭句柄再抛）。 */
  private async init(): Promise<SqliteDatabase> {
    let handle: SqliteDatabase | undefined;
    try {
      handle = await openDatabase(this.dbPath);
      handle.ensureSchema();
    } catch (error) {
      if (handle !== undefined) {
        try {
          handle.close();
        } catch {
          // 关闭失败忽略
        }
      }
      throw new ExecutionLogError(`执行日志数据库打开/建表失败：${this.dbPath}（${describeError(error)}）`, error);
    }
    if (handle === undefined) {
      // 理论不可达：try 成功则必有句柄
      throw new ExecutionLogError(`执行日志数据库初始化异常：${this.dbPath}`);
    }
    return handle;
  }

  /** 补全缺省字段：id 用 randomUUID，createdAt 用 Date.now()。 */
  private normalize(entry: ExecutionLogEntry): ExecutionLogEntry {
    return {
      id: entry.id ?? randomUUID(),
      runId: entry.runId,
      workflowId: entry.workflowId,
      nodeId: entry.nodeId,
      level: entry.level,
      message: entry.message,
      ...(entry.data === undefined ? {} : { data: entry.data }),
      createdAt: entry.createdAt ?? Date.now(),
    };
  }

  /** 单事务写入一批条目；失败回滚、恢复缓冲并抛 ExecutionLogError（可重试）。 */
  private writeBatch(handle: SqliteDatabase, pending: ExecutionLogEntry[]): void {
    const insert = handle.db.prepare(INSERT_LOG_SQL);
    try {
      handle.db.exec("BEGIN");
      for (const entry of pending) {
        insert.run(
          entry.id ?? randomUUID(),
          entry.runId,
          entry.workflowId,
          entry.nodeId,
          entry.level,
          entry.message,
          serializeData(entry.data),
          entry.createdAt ?? Date.now(),
        );
      }
      handle.db.exec("COMMIT");
    } catch (error) {
      try {
        handle.db.exec("ROLLBACK");
      } catch {
        // 回滚失败：事务已由驱动终止，忽略
      }
      this.restoreBuffer(pending);
      throw new ExecutionLogError(`执行日志写入失败：${this.dbPath}（${describeError(error)}）`, error);
    }
  }

  /** 取走当前缓冲并清空（并发 flush 互不干扰：单线程下取走是原子的）。 */
  private takeBuffer(): ExecutionLogEntry[] {
    const pending = this.buffer;
    this.buffer = [];
    return pending;
  }

  /** flush 失败后把未写入条目放回缓冲头部，保证不丢数据、可重试。 */
  private restoreBuffer(pending: ExecutionLogEntry[]): void {
    this.buffer = [...pending, ...this.buffer];
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ExecutionLogError(`执行日志存储已关闭，拒绝操作：${this.dbPath}`);
    }
  }
}

/** 构建 WHERE 子句与绑定参数（列名下划线）。 */
function buildWhere(query: ExecutionLogQuery): { whereSql: string; params: SqliteBindValue[] } {
  const clauses: string[] = [];
  const params: SqliteBindValue[] = [];
  if (query.runId !== undefined) {
    clauses.push("run_id = ?");
    params.push(query.runId);
  }
  if (query.workflowId !== undefined) {
    clauses.push("workflow_id = ?");
    params.push(query.workflowId);
  }
  if (query.nodeId !== undefined) {
    clauses.push("node_id = ?");
    params.push(query.nodeId);
  }
  if (query.level !== undefined) {
    clauses.push("level = ?");
    params.push(query.level);
  }
  return { whereSql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

/** data 字段序列化：undefined 存 NULL，其余 JSON 字符串。 */
function serializeData(data: unknown | undefined): string | null {
  return data === undefined ? null : JSON.stringify(data);
}

/** data 列反序列化：NULL → undefined（省略字段）；JSON 解析失败 → null 并继续。 */
function parseDataColumn(value: unknown): unknown | null | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** SQLite 行 → 日志条目（列名下划线映射到驼峰字段）。 */
function rowToEntry(row: SqliteRow): ExecutionLogEntry {
  const parsedData = parseDataColumn(row.data);
  return {
    id: asString(row.id, ""),
    runId: asString(row.run_id, ""),
    workflowId: asString(row.workflow_id, ""),
    nodeId: asString(row.node_id, ""),
    level: asLevel(row.level, "info"),
    message: asString(row.message, ""),
    createdAt: asNumber(row.created_at, 0),
    ...(parsedData === undefined ? {} : { data: parsedData }),
  };
}

/** 列值 → 字符串：非字符串回退到 fallback。 */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 列值 → number：number/bigint 兼容，其余回退。 */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : fallback;
}

/** 列值 → LogLevel：未知级别回退到 fallback。 */
function asLevel(value: unknown, fallback: LogLevel): LogLevel {
  return value === "info" || value === "warn" || value === "error" ? value : fallback;
}

/** 提取错误的可读消息。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
