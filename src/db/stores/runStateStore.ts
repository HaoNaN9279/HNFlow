// RunState SQLite 持久化：整对象 JSON 存 state 列，upsert 语义对齐 JSON 版（src/runstate/RunStateStore.ts）。
import type { SqliteRow } from "../adapter.js";
import type { SqliteDatabase } from "../index.js";
import { openDatabase } from "../index.js";
import type { RunState } from "../../runstate/types.js";
import type { RunStateStoreLike } from "./types.js";

export class SqliteRunStateStore implements RunStateStoreLike {
  private db: SqliteDatabase | undefined;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 写入断点：INSERT OR REPLACE（同 runId 覆盖，upsert 语义）。 */
  async create(run: RunState): Promise<void> {
    const db = await this.ensureOpened();
    db.db.prepare(
      "INSERT OR REPLACE INTO run_state (run_id, workflow_id, status, state, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(run.runId, run.workflowId, run.status, JSON.stringify(run), run.updatedAt);
  }

  /** 同 create，upsert 语义。 */
  async update(run: RunState): Promise<void> {
    await this.create(run);
  }

  async getById(runId: string): Promise<RunState | undefined> {
    const db = await this.ensureOpened();
    const row = db.db.prepare("SELECT state FROM run_state WHERE run_id = ?").get(runId);
    return row === undefined ? undefined : parseRunStateRow(row);
  }

  async list(): Promise<RunState[]> {
    const db = await this.ensureOpened();
    return db.db.prepare("SELECT state FROM run_state ORDER BY updated_at, run_id").all().map(parseRunStateRow);
  }

  async listByWorkflow(workflowId: string): Promise<RunState[]> {
    const db = await this.ensureOpened();
    return db.db
      .prepare("SELECT state FROM run_state WHERE workflow_id = ? ORDER BY updated_at, run_id")
      .all(workflowId)
      .map(parseRunStateRow);
  }

  /** 关闭连接；重复 close 幂等。 */
  async close(): Promise<void> {
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
  }

  private async ensureOpened(): Promise<SqliteDatabase> {
    if (this.db === undefined) {
      const db = await openDatabase(this.dbPath);
      db.ensureSchema();
      this.db = db;
    }
    return this.db;
  }
}

/** 解析 run_state.state 列（整对象 JSON），失败抛中文错误。 */
function parseRunStateRow(row: SqliteRow): RunState {
  const raw = row.state;
  if (typeof raw !== "string") {
    throw new Error(`run_state.state 应为 JSON 字符串，实际为 ${describeValue(raw)}`);
  }
  try {
    return JSON.parse(raw) as RunState;
  } catch (error) {
    throw new Error(`run_state.state JSON 解析失败: ${describeError(error)}`);
  }
}

function describeValue(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
