// human_tasks 行解析：SQLite 行 → HumanTask（各列类型校验 + JSON 列解析，失败抛中文错误）。
import type { SqliteRow } from "../adapter.js";
import type { HumanTask, HumanTaskFallback, HumanTaskStatus } from "../../human/types.js";

/** 将 human_tasks 行解析为 HumanTask；可选列（description/meta/result/completed_at）缺省为 undefined。 */
export function parseTaskRow(row: SqliteRow): HumanTask {
  const description = optionalString(row, "description");
  const completedAt = optionalNumber(row, "completed_at");
  const metaRaw = optionalNonNull(row, "meta");
  const resultRaw = optionalNonNull(row, "result");
  return {
    id: requiredString(row, "id"),
    workflowId: requiredString(row, "workflow_id"),
    nodeId: requiredString(row, "node_id"),
    nodeName: requiredString(row, "node_name"),
    title: requiredString(row, "title"),
    status: parseStatus(row),
    fallback: parseFallback(row),
    createdAt: requiredNumber(row, "created_at"),
    ...(description === undefined ? {} : { description }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(metaRaw === undefined ? {} : { meta: parseMetaObject(metaRaw) }),
    ...(resultRaw === undefined ? {} : { result: parseResultValue(resultRaw) }),
  };
}

function requiredString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`human_tasks.${column} 应为字符串，实际为 ${describeValue(value)}`);
  }
  return value;
}

function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new Error(`human_tasks.${column} 应为数字，实际为 ${describeValue(value)}`);
  }
  return value;
}

function optionalString(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`human_tasks.${column} 应为字符串，实际为 ${describeValue(value)}`);
  }
  return value;
}

function optionalNumber(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`human_tasks.${column} 应为数字，实际为 ${describeValue(value)}`);
  }
  return value;
}

/** 可选列：NULL/缺省返回 undefined，否则原样返回。 */
function optionalNonNull(row: SqliteRow, column: string): unknown {
  const value = row[column];
  return value === null || value === undefined ? undefined : value;
}

function parseStatus(row: SqliteRow): HumanTaskStatus {
  const value = row.status;
  if (value === "pending" || value === "completed" || value === "skipped" || value === "deferred") {
    return value;
  }
  throw new Error(`human_tasks.status 非法: ${describeValue(value)}`);
}

function parseFallback(row: SqliteRow): HumanTaskFallback {
  const value = row.fallback;
  if (value === "manual" || value === "skip" || value === "ai" || value === "defer") {
    return value;
  }
  throw new Error(`human_tasks.fallback 非法: ${describeValue(value)}`);
}

/** meta 列：JSON 字符串 → 对象（非对象抛中文错误）。 */
function parseMetaObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    throw new Error(`human_tasks.meta 应为 JSON 字符串，实际为 ${describeValue(raw)}`);
  }
  const parsed = parseJsonValue(raw, "meta");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`human_tasks.meta 应为对象 JSON，实际为 ${String(raw)}`);
  }
  return parsed as Record<string, unknown>;
}

/** result 列：JSON 字符串 → 任意值。 */
function parseResultValue(raw: unknown): unknown {
  if (typeof raw !== "string") {
    throw new Error(`human_tasks.result 应为 JSON 字符串，实际为 ${describeValue(raw)}`);
  }
  return parseJsonValue(raw, "result");
}

/** JSON.parse 封装：失败抛带列名的中文错误。 */
function parseJsonValue(raw: string, column: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`human_tasks.${column} JSON 解析失败: ${describeError(error)}`);
  }
}

function describeValue(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
