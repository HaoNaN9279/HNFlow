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
 * 再逐表幂等建表，最后执行增量迁移（v0.2.5 T2/T4：run_state.idempotency_key 列 + 唯一索引、
 * human_tasks.run_id 列）。可重复调用；迁移段对既有库（列缺失）幂等补列，对新库（列已存在）跳过。
 */
export function ensureSchema(db: SqliteAdapter): void {
  db.exec("PRAGMA journal_mode = WAL");
  for (const ddl of TABLE_DDL) {
    db.exec(ddl);
  }
  migrateRunStateIdempotency(db);
  migrateHumanTasksRunId(db);
}

/**
 * 增量迁移：PRAGMA table_info 探测 run_state.idempotency_key 列缺失 → ALTER TABLE ADD COLUMN，
 * 再建 (workflow_id, idempotency_key) 唯一索引。SQLite 唯一索引允许多 NULL——
 * 旧库既有行 idempotency_key 为 NULL 不参与判重，天然兼容；只对非 NULL 幂等键判重。
 */
function migrateRunStateIdempotency(db: SqliteAdapter): void {
  const columns = db.prepare("PRAGMA table_info(run_state)").all();
  const hasColumn = columns.some((column) => column.name === "idempotency_key");
  if (!hasColumn) {
    db.exec("ALTER TABLE run_state ADD COLUMN idempotency_key TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_state_idempotency ON run_state (workflow_id, idempotency_key)");
}

/**
 * 增量迁移：PRAGMA table_info 探测 human_tasks.run_id 列缺失 → ALTER TABLE ADD COLUMN。
 * 旧库既有行 run_id 为 NULL，findPending 不传 runId 时按旧语义（workflowId+nodeId）匹配，天然兼容。
 */
function migrateHumanTasksRunId(db: SqliteAdapter): void {
  const columns = db.prepare("PRAGMA table_info(human_tasks)").all();
  const hasColumn = columns.some((column) => column.name === "run_id");
  if (!hasColumn) {
    db.exec("ALTER TABLE human_tasks ADD COLUMN run_id TEXT");
  }
}
