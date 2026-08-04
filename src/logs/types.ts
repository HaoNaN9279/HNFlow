// ExecutionLog 存储的类型定义：日志条目、查询条件、错误类型。

/** 日志级别：info 普通信息、warn 警告、error 错误。 */
export type LogLevel = "info" | "warn" | "error";

/**
 * 持久化日志条目。
 * id/createdAt 缺省时由 store 在 append 时内部生成（randomUUID / Date.now()）。
 */
export interface ExecutionLogEntry {
  readonly id?: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: unknown;
  readonly createdAt?: number;
}

/** 查询过滤条件：未指定的字段不过滤，全部条件按交集（AND）匹配。 */
export interface ExecutionLogQuery {
  readonly runId?: string;
  readonly workflowId?: string;
  readonly nodeId?: string;
  readonly level?: LogLevel;
  readonly limit?: number;
}

/** 执行日志存储错误：消息含 db 路径与底层原因（中文）。 */
export class ExecutionLogError extends Error {
  readonly name = "ExecutionLogError";

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
