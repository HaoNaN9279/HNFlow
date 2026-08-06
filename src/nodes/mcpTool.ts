// MCP 工具调用节点：直接调用 MCP Server 的指定工具，确定性执行，不走 AI 节点。
// 配置快照（command/args/env/cwd/stateful）随节点参数保存，拖拽生成时自动填充。

import type { INodeDefinition } from "../execution/types.js";
import type { McpCallResult } from "../mcp/types.js";

/** mcpTool 节点参数格式非法（serverName/toolName/mcpConfig 缺失或类型错误） */
export class InvalidMcpToolParamsError extends Error {
  readonly name = "InvalidMcpToolParamsError";

  constructor(readonly params: unknown) {
    super(
      "无效的 MCP 工具参数：期望 { serverName: string, toolName: string, mcpConfig: { command: string, args?, env?, cwd?, stateful? }, args? }",
    );
  }
}

/** 引擎未注入 MCP 进程池（NodeExecutionContext.mcpPool 缺失） */
export class McpPoolUnavailableError extends Error {
  readonly name = "McpPoolUnavailableError";

  constructor() {
    super("引擎未配置 MCP 池");
  }
}

/** acquire 会话或调用工具失败（携带 serverName/toolName 定位） */
export class McpToolCallError extends Error {
  readonly name = "McpToolCallError";

  constructor(
    readonly serverName: string,
    readonly toolName: string,
    cause: unknown,
  ) {
    super(
      `MCP 工具调用失败：server=${serverName} tool=${toolName}（${cause instanceof Error ? cause.message : String(cause)}）`,
      { cause },
    );
  }
}

/** 解析后的 mcpConfig：与 McpServerConfig 对齐（不含 name，acquire 时补上） */
interface McpConfigParams {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly stateful?: boolean;
}

/** 解析后的 mcpTool 参数 */
interface McpToolParams {
  readonly serverName: string;
  readonly toolName: string;
  readonly mcpConfig: McpConfigParams;
  readonly args: Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 解析 env：值必须全为 string，返回可变拷贝（与 McpServerConfig.env 形状一致） */
function parseStringRecord(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      return undefined;
    }
    record[key] = value;
  }
  return record;
}

/** 边界解析 mcpConfig：command 必填，其余字段缺省合法 */
function parseMcpConfig(raw: unknown): McpConfigParams | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const command = record["command"];
  if (typeof command !== "string") {
    return undefined;
  }
  const args = record["args"];
  if (args !== undefined && !isStringArray(args)) {
    return undefined;
  }
  const env = parseStringRecord(record["env"]);
  if (env === undefined && record["env"] !== undefined) {
    return undefined;
  }
  const cwd = record["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") {
    return undefined;
  }
  const stateful = record["stateful"];
  if (stateful !== undefined && typeof stateful !== "boolean") {
    return undefined;
  }
  return {
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(stateful === undefined ? {} : { stateful }),
  };
}

/** 边界解析：从未知参数记录解析 mcpTool 参数，非法返回 undefined */
function parseParams(params: Readonly<Record<string, unknown>>): McpToolParams | undefined {
  const serverName = params["serverName"];
  if (typeof serverName !== "string") {
    return undefined;
  }
  const toolName = params["toolName"];
  if (typeof toolName !== "string") {
    return undefined;
  }
  const mcpConfig = parseMcpConfig(params["mcpConfig"]);
  if (mcpConfig === undefined) {
    return undefined;
  }
  const callArgs = params["args"];
  if (
    callArgs !== undefined &&
    (callArgs === null || typeof callArgs !== "object" || Array.isArray(callArgs))
  ) {
    return undefined;
  }
  return {
    serverName,
    toolName,
    mcpConfig,
    args: callArgs === undefined ? {} : (callArgs as Record<string, unknown>),
  };
}

/** 规范化 callTool 结果：优先拼接文本，无文本时序列化 raw 兜底 */
function formatCallResult(result: McpCallResult): string {
  if (result.text !== "") {
    return result.text;
  }
  const serialized = JSON.stringify(result.raw);
  return serialized === undefined ? "" : serialized;
}

export const mcpToolNode: INodeDefinition = {
  type: "mcpTool",
  name: "MCP 工具调用",
  paramsSchema: [
    {
      key: "serverName",
      label: "MCP Server 名",
      type: "string",
      required: true,
      placeholder: "MCP Server 名（来自功能组 mcp.json）",
    },
    {
      key: "toolName",
      label: "工具名",
      type: "string",
      required: true,
      placeholder: "工具名（tools/list 发现）",
    },
    {
      key: "mcpConfig",
      label: "MCP Server 配置",
      type: "json",
      required: true,
      description: "MCP Server 配置快照（command/args/env/cwd/stateful），拖拽生成时自动填充",
    },
    {
      key: "args",
      label: "工具调用参数",
      type: "json",
      description: "工具调用参数 JSON",
    },
  ],
  inputs: [],
  outputs: [
    { id: "result", name: "result", type: "string", direction: "out" },
  ],
  async execute(ctx) {
    const params = parseParams(ctx.node.params);
    if (params === undefined) {
      throw new InvalidMcpToolParamsError(ctx.node.params);
    }
    const pool = ctx.mcpPool;
    if (pool === undefined) {
      throw new McpPoolUnavailableError();
    }
    try {
      const session = await pool.acquire({ name: params.serverName, ...params.mcpConfig });
      const result = await session.callTool(params.toolName, params.args);
      return { result: formatCallResult(result) };
    } catch (error) {
      throw new McpToolCallError(params.serverName, params.toolName, error);
    }
  },
};
