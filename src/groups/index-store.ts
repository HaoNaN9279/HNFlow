// 功能组全局索引库（v0.3.0 T3）：group_index + resource_registry 两表的封装。
// 索引仅作加速与查询（namespace/aliases 快速定位、资源行登记），解析始终以 group.json 为准（T4 统一接线）。
// SQL 惯例同 src/db/stores/runStateStore.ts：prepared statement + 懒打开建表；
// openGroupIndex 工厂立即建表，保证打开既有文件库重复执行 CREATE TABLE IF NOT EXISTS 幂等不炸。
// 时间戳：updatedAt 用 Date.now()（INTEGER 毫秒，与 run_state.updated_at 惯例一致）；
// groups.createdAt（ISO 字符串）是版本创建时间，与索引更新时间语义不同，不混用。
import type { SqliteRow } from "../db/adapter.js";
import type { SqliteDatabase } from "../db/index.js";
import { openDatabase } from "../db/index.js";
import type { ResourceEntry, ResourceType } from "./types.js";

/** upsertGroup 入参：功能组索引行更新快照。 */
export interface GroupIndexUpsert {
  readonly guid: string;
  readonly namespace: string;
  readonly currentVersion: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly updatedAt: number;
}

/** group_index 表行解析结果（与 upsert 入参同构，读取侧单独声明便于扩展）。 */
export interface GroupIndexEntry {
  readonly guid: string;
  readonly namespace: string;
  readonly currentVersion: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly updatedAt: number;
}

/** resource_registry 表行。 */
export interface ResourceRow {
  readonly guid: string;
  readonly version: string;
  readonly type: ResourceType;
  readonly name: string;
  readonly path: string;
}

/** 索引库公共接口：供 T4/T7 注入使用（索引可随时重建，查询失败不阻塞解析）。 */
export interface GroupIndex {
  upsertGroup(entry: GroupIndexUpsert): Promise<void>;
  getGroup(guid: string): Promise<GroupIndexEntry | undefined>;
  /** 按 namespace 查找，含 aliases 匹配；未命中返回 undefined。 */
  findByNamespace(namespace: string): Promise<GroupIndexEntry | undefined>;
  /** 按 namespace 字典序返回全部索引行。 */
  listGroups(): Promise<GroupIndexEntry[]>;
  /** 批量登记资源行：INSERT OR IGNORE，重复 (guid, version, type, name) 幂等不报错。 */
  upsertResources(entries: ReadonlyArray<ResourceEntry & { readonly guid: string; readonly version: string }>): Promise<void>;
  /** 按 guid + version 过滤资源行（版本目录内资源全集）。 */
  listResources(guid: string, version: string): Promise<ResourceRow[]>;
  close(): Promise<void>;
}

/** SQLite 实现：路径支持 ":memory:"（测试）与文件库（T7 接 groups/.hnflow-groups.db）。 */
export class SqliteGroupIndex implements GroupIndex {
  private db: SqliteDatabase | undefined;
  private readonly indexPath: string;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  /** INSERT OR REPLACE：同 guid 覆盖（upsert 语义）。 */
  async upsertGroup(entry: GroupIndexUpsert): Promise<void> {
    const db = await this.ensureOpened();
    db.db.prepare(
      "INSERT OR REPLACE INTO group_index (guid, namespace, current_version, aliases, description, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(entry.guid, entry.namespace, entry.currentVersion, JSON.stringify(entry.aliases), entry.description, entry.updatedAt);
  }

  async getGroup(guid: string): Promise<GroupIndexEntry | undefined> {
    const db = await this.ensureOpened();
    const row = db.db.prepare("SELECT * FROM group_index WHERE guid = ?").get(guid);
    return row === undefined ? undefined : parseGroupIndexRow(row);
  }

  /** 先精确匹配 namespace，未命中再全表扫描 aliases（JSON 列内存比对，命中即返回首个）。 */
  async findByNamespace(namespace: string): Promise<GroupIndexEntry | undefined> {
    const db = await this.ensureOpened();
    const exact = db.db.prepare("SELECT * FROM group_index WHERE namespace = ?").get(namespace);
    if (exact !== undefined) {
      return parseGroupIndexRow(exact);
    }
    const rows = db.db.prepare("SELECT * FROM group_index").all();
    for (const row of rows) {
      const entry = parseGroupIndexRow(row);
      if (entry.aliases.includes(namespace)) {
        return entry;
      }
    }
    return undefined;
  }

  async listGroups(): Promise<GroupIndexEntry[]> {
    const db = await this.ensureOpened();
    return db.db.prepare("SELECT * FROM group_index ORDER BY namespace").all().map(parseGroupIndexRow);
  }

  /** 批量登记：逐条 INSERT OR IGNORE，受 (guid, version, type, name) 主键约束，重复不抛错。 */
  async upsertResources(entries: ReadonlyArray<ResourceEntry & { readonly guid: string; readonly version: string }>): Promise<void> {
    const db = await this.ensureOpened();
    const stmt = db.db.prepare(
      "INSERT OR IGNORE INTO resource_registry (guid, version, type, name, path) VALUES (?, ?, ?, ?, ?)",
    );
    for (const entry of entries) {
      stmt.run(entry.guid, entry.version, entry.type, entry.name, entry.path);
    }
  }

  async listResources(guid: string, version: string): Promise<ResourceRow[]> {
    const db = await this.ensureOpened();
    return db.db
      .prepare("SELECT * FROM resource_registry WHERE guid = ? AND version = ?")
      .all(guid, version)
      .map(parseResourceRow);
  }

  /** 关闭连接；重复 close 幂等。 */
  async close(): Promise<void> {
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
  }

  /** 打开连接并建表（幂等）；类方法懒调用，openGroupIndex 工厂立即调用。不进 GroupIndex 接口契约。 */
  async ensureOpened(): Promise<SqliteDatabase> {
    if (this.db === undefined) {
      const db = await openDatabase(this.indexPath);
      db.ensureSchema(); // ensureSchema 会建全部业务表（含本模块两表），冗余建表幂等无害
      this.db = db;
    }
    return this.db;
  }
}

/** 打开索引库：立即建表并返回句柄；文件路径自动创建，":memory:" 为独立内存库。 */
export async function openGroupIndex(indexPath: string): Promise<GroupIndex> {
  const index = new SqliteGroupIndex(indexPath);
  await index.ensureOpened();
  return index;
}

function parseGroupIndexRow(row: SqliteRow): GroupIndexEntry {
  return {
    guid: requireString(row, "group_index", "guid"),
    namespace: requireString(row, "group_index", "namespace"),
    currentVersion: requireString(row, "group_index", "current_version"),
    aliases: parseAliases(row.aliases),
    description: requireString(row, "group_index", "description"),
    updatedAt: requireNumber(row, "group_index", "updated_at"),
  };
}

function parseResourceRow(row: SqliteRow): ResourceRow {
  return {
    guid: requireString(row, "resource_registry", "guid"),
    version: requireString(row, "resource_registry", "version"),
    type: requireResourceType(row.type),
    name: requireString(row, "resource_registry", "name"),
    path: requireString(row, "resource_registry", "path"),
  };
}

/** aliases 列：JSON 数组字符串 → readonly string[]；解析失败抛中文错误。 */
function parseAliases(raw: unknown): readonly string[] {
  if (typeof raw !== "string") {
    throw new Error(`group_index.aliases 应为 JSON 字符串，实际为 ${describeValue(raw)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`group_index.aliases JSON 解析失败: ${describeError(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("group_index.aliases 应为字符串数组");
  }
  return parsed;
}

function requireResourceType(value: unknown): ResourceType {
  if (value === "agent" || value === "tool" || value === "mcp" || value === "rule") {
    return value;
  }
  throw new Error(`resource_registry.type 应为合法资源类型，实际为 ${describeValue(value)}`);
}

function requireString(row: SqliteRow, table: string, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`${table}.${column} 应为字符串，实际为 ${describeValue(value)}`);
  }
  return value;
}

function requireNumber(row: SqliteRow, table: string, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new Error(`${table}.${column} 应为数字，实际为 ${describeValue(value)}`);
  }
  return value;
}

function describeValue(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
