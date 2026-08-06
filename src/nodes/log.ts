// 日志输出节点：按 params.level 调用上下文 logger 输出 params.message。

import type { INodeDefinition } from "../execution/types.js";

/** 日志级别 */
type LogLevel = "info" | "warn" | "error";

/** log 节点参数结构 */
interface LogParams {
  readonly level: LogLevel;
  readonly message: string;
}

/** log 节点参数缺失或格式错误 */
export class InvalidLogParamsError extends Error {
  readonly name = "InvalidLogParamsError";

  constructor() {
    super("invalid log params: expected { level?: 'info' | 'warn' | 'error', message: string }");
  }
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "info" || value === "warn" || value === "error";
}

function assertNever(value: never): never {
  throw new Error(`unreachable log level: ${JSON.stringify(value)}`);
}

/** 边界解析：从未知 params 解析为类型化 LogParams，非法返回 undefined */
function parseLogParams(params: Readonly<Record<string, unknown>>): LogParams | undefined {
  const message = params["message"];
  if (typeof message !== "string") {
    return undefined;
  }
  const rawLevel = params["level"];
  const level = rawLevel === undefined ? "info" : rawLevel;
  if (!isLogLevel(level)) {
    return undefined;
  }
  return { level, message };
}

export const logNode: INodeDefinition = {
  type: "log",
  name: "日志输出",
  paramsSchema: [
    { key: "message", label: "日志内容", type: "textarea", required: true },
    { key: "level", label: "日志级别", type: "select", default: "info", options: [
      { label: "info", value: "info" },
      { label: "warn", value: "warn" },
      { label: "error", value: "error" },
    ] },
  ],
  inputs: [],
  outputs: [],
  async execute(ctx) {
    const params = parseLogParams(ctx.node.params);
    if (params === undefined) {
      throw new InvalidLogParamsError();
    }
    switch (params.level) {
      case "info":
        ctx.logger.info(params.message);
        break;
      case "warn":
        ctx.logger.warn(params.message);
        break;
      case "error":
        ctx.logger.error(params.message);
        break;
      default:
        assertNever(params.level);
    }
    return {};
  },
};
