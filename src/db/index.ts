// SQLite 数据库入口：打开适配器 + 建表，返回统一包装对象。
import { detectDriver, openAdapter, type DriverKind, type SqliteAdapter } from "./adapter.js";
import { ensureSchema } from "./schema.js";

export { detectDriver, openAdapter } from "./adapter.js";
export type {
  DriverKind,
  SqliteAdapter,
  SqliteBindValue,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "./adapter.js";

// T6：store 持久化实现（RunState/HumanTask 的 SQLite 版）入口 re-export。
export type { HumanTaskStoreLike, RunStateStoreLike } from "./stores.js";
export { SqliteHumanTaskStore, SqliteRunStateStore } from "./stores.js";

/** openDatabase 选项。 */
export interface OpenDatabaseOptions {
  /** 指定驱动；默认 detectDriver() 自动检测（测试可覆盖）。 */
  readonly driver?: DriverKind;
}

/** 打开的数据库包装对象。 */
export interface SqliteDatabase {
  readonly driver: DriverKind;
  readonly db: SqliteAdapter;
  /** 建表（幂等）：执行 PRAGMA journal_mode = WAL 并确保三张业务表存在。 */
  ensureSchema(): void;
  /** 关闭连接。 */
  close(): void;
}

/** 打开 SQLite 数据库（文件库或 ":memory:"），返回可用的包装对象。 */
export async function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): Promise<SqliteDatabase> {
  const driver = options.driver ?? detectDriver();
  const db = await openAdapter(driver, filePath);
  return {
    driver,
    db,
    ensureSchema: () => ensureSchema(db),
    close: () => db.close(),
  };
}
