// SQLite 表结构定义：幂等建表，供 openDatabase 初始化调用。
import type { SqliteAdapter } from "./adapter.js";

/** 五张业务表的 DDL（CREATE TABLE IF NOT EXISTS，可重复执行）。 */
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
  // langgraph checkpoint 约定：checkpoint/metadata 存序列化 bytes，checkpoint_ns 支持命名空间隔离。
  `CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT NOT NULL DEFAULT '',
    checkpoint BLOB NOT NULL,
    metadata BLOB NOT NULL,
    updated_at INTEGER,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT '',
    blob BLOB NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
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
