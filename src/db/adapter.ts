// SQLite 运行时适配层：统一 bun:sqlite 与 node:sqlite 的差异，暴露一致的 exec/prepare/get/all/run 接口。
// 两个驱动都通过动态 import 延迟加载——node:sqlite 在 bun 下无法解析，禁止顶层静态 import；
// bun:sqlite 同理，保证本模块在纯 node 环境也能安全加载、由 detectDriver 分流。

/** 驱动标识：bun 用内置 bun:sqlite，node 用内置 node:sqlite。 */
export type DriverKind = "bun" | "node";

/** SQL 绑定参数允许的取值类型（两种驱动支持类型的交集；node:sqlite 不支持 boolean 绑定）。 */
export type SqliteBindValue = string | number | bigint | null | Uint8Array;

/** 查询结果行：键为列名，值为 SQLite 返回的类型。 */
export type SqliteRow = Record<string, unknown>;

/** run() 归一化结果：changes 恒为 number（node:sqlite 可能返回 bigint，已统一转换）。 */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** 预编译语句统一接口。 */
export interface SqliteStatement {
  /** 取首行；无结果返回 undefined（bun 的 null 已归一化）。 */
  get(...params: SqliteBindValue[]): SqliteRow | undefined;
  /** 取全部行；无结果返回空数组。 */
  all(...params: SqliteBindValue[]): SqliteRow[];
  /** 执行写操作，返回归一化结果。 */
  run(...params: SqliteBindValue[]): SqliteRunResult;
}

/** SQLite 数据库统一接口。 */
export interface SqliteAdapter {
  /** 执行不返回结果的 SQL（DDL、PRAGMA 等）。 */
  exec(sql: string): void;
  /** 预编译 SQL 语句。 */
  prepare(sql: string): SqliteStatement;
  /** 关闭连接；重复调用由驱动决定是否安全，调用方保证只关一次。 */
  close(): void;
}

/** 检测当前运行时：存在全局 Bun 即视为 bun。 */
export function detectDriver(): DriverKind {
  return typeof globalThis.Bun !== "undefined" ? "bun" : "node";
}

/** 打开适配器：按 driver 动态加载对应内置模块并包装。 */
export async function openAdapter(driver: DriverKind, filePath: string): Promise<SqliteAdapter> {
  if (driver === "bun") {
    const { Database } = await import("bun:sqlite");
    return new BunSqliteAdapter(new Database(filePath));
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new NodeSqliteAdapter(new DatabaseSync(filePath));
}

/** bun:sqlite 包装：query → prepare、get 的 null → undefined。 */
class BunSqliteAdapter implements SqliteAdapter {
  private readonly db: import("bun:sqlite").Database;

  constructor(db: import("bun:sqlite").Database) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.run(sql); // exec 已弃用，用 run 执行无返回 SQL
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare<SqliteRow, SqliteBindValue[]>(sql);
    return {
      get: (...params) => stmt.get(...params) ?? undefined,
      all: (...params) => stmt.all(...params),
      run: (...params) => normalizeRunResult(stmt.run(...params)),
    };
  }

  close(): void {
    this.db.close();
  }
}

/** node:sqlite 包装：run() 的 changes 可能为 bigint，统一转 number。 */
class NodeSqliteAdapter implements SqliteAdapter {
  private readonly db: import("node:sqlite").DatabaseSync;

  constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare(sql);
    return {
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
      run: (...params) => normalizeRunResult(stmt.run(...params)),
    };
  }

  close(): void {
    this.db.close();
  }
}

/** 归一化 run 结果：changes 可能为 bigint（node:sqlite），统一转 number。 */
function normalizeRunResult(result: { changes: number | bigint; lastInsertRowid: number | bigint }): SqliteRunResult {
  return { changes: toNumber(result.changes), lastInsertRowid: result.lastInsertRowid };
}

/** bigint → number；number 原样返回。 */
function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}
