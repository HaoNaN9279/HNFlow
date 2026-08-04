// SQLite 表结构定义：幂等建表，供 openDatabase 初始化调用。
import type { SqliteAdapter } from "./adapter.js";

/** 三张业务表的 DDL（CREATE TABLE IF NOT EXISTS，可重复执行）。 */
const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS execution_logs (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    workflow_id TEXT,
    node_id TEXT,
    level TEXT,
    message TEXT,
    data TEXT,
    created_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS run_state (
    run_id TEXT PRIMARY KEY,
    workflow_id TEXT,
    status TEXT,
    state TEXT,
    updated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS human_tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT,
    node_id TEXT,
    node_name TEXT,
    title TEXT,
    status TEXT,
    description TEXT,
    meta TEXT,
    result TEXT,
    fallback TEXT,
    created_at INTEGER,
    completed_at INTEGER
  )`,
];

/**
 * 确保表结构就绪：先切 WAL（文件库生效；内存库返回 memory 属正常，不报错），
 * 再逐表幂等建表。可重复调用。
 */
export function ensureSchema(db: SqliteAdapter): void {
  db.exec("PRAGMA journal_mode = WAL");
  for (const ddl of TABLE_DDL) {
    db.exec(ddl);
  }
}
