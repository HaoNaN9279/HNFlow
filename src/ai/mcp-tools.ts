// MCP 工具解析（v0.4.2 D2）：activeGroups.mcps → 进程池会话 → 工具发现 → HNFlowTool。
// 单 MCP 故障不炸 AI 节点：acquire/发现失败均捕获并 warn 跳过，其余 MCP 继续。
// release 语义：会话由进程池引用计数管理（空闲超时释放），AI 节点执行完不主动 release，
// 同一节点多次执行复用同一子进程（验收「进程池能复用」）。
import { discoverMcpTools } from "../mcp/tools.js";
import type { McpInputSchema, McpToolHandle } from "../mcp/tools.js";
import type { McpServerPool } from "../mcp/pool.js";
import type { McpSession } from "../mcp/session.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { MergedGroups, MergedMcp } from "../groups/merge.js";
import type { HNFlowTool } from "./types.js";

/** 默认 warn 出口：调用方未注入日志器时降级 console（引擎路径由 ai.ts 注入节点 logger）。 */
function defaultWarn(msg: string, data?: unknown): void {
  console.warn(msg, data);
}

/** 运行时判断：非空非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 错误信息提取：非 Error 值退化为字符串。 */
function errorMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析字符串数组字段（args）：非数组 / 含非字符串元素 → undefined（尽力解析）。 */
function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item);
    }
  }
  return result;
}

/** 解析字符串映射字段（env）：非对象 / 含非字符串值 → undefined（尽力解析）。 */
function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

/** 解析 mcp.json config → McpServerConfig；command 缺失/非字符串返回 undefined（调用方 warn 跳过）。 */
function parseMcpServerConfig(merged: MergedMcp): McpServerConfig | undefined {
  const raw = merged.config;
  const command = raw["command"];
  if (typeof command !== "string" || command === "") {
    return undefined;
  }
  const args = parseStringArray(raw["args"]);
  const env = parseStringMap(raw["env"]);
  const cwd = typeof raw["cwd"] === "string" ? raw["cwd"] : undefined;
  const stateful = typeof raw["stateful"] === "boolean" ? raw["stateful"] : undefined;
  return {
    name: merged.name,
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(stateful === undefined ? {} : { stateful }),
  };
}

/** 会话工具 inputSchema（Record）→ MCP 描述 inputSchema（object 形状，供 zod 转换）。 */
function toMcpInputSchema(raw: Record<string, unknown>): McpInputSchema {
  const required: string[] = [];
  const rawRequired = raw["required"];
  if (Array.isArray(rawRequired)) {
    for (const item of rawRequired) {
      if (typeof item === "string") {
        required.push(item);
      }
    }
  }
  return {
    type: "object",
    ...(raw["properties"] === undefined ? {} : { properties: raw["properties"] }),
    ...(required.length > 0 ? { required } : {}),
  };
}

/** McpSession → McpToolHandle 适配：会话实现类型与工具发现层最小接口不一致，桥接字段形状。 */
function sessionToToolHandle(session: McpSession): McpToolHandle {
  return {
    async listTools() {
      const tools = session.listTools().map((info) => ({
        name: info.name,
        ...(info.description === undefined ? {} : { description: info.description }),
        inputSchema: toMcpInputSchema(info.inputSchema),
      }));
      return { tools };
    },
    async callTool(name, args) {
      const result = await session.callTool(name, args);
      return result.text;
    },
  };
}

/**
 * 功能组 MCP 解析为 HNFlowTool。
 * 无 activeGroups / mcps 为空 / pool 未配置 → []（行为同旧版，AI 节点不加载 MCP 工具）。
 * namespace 前缀与 merge 层 applyNamespace 语义一致：namespace 空时 mcpName 原样，
 * 非空时 `<namespace>.<mcpName>`；最终 fullName = `<前缀>.<toolName>`。
 * 单 MCP 配置非法 / 启动失败 / 发现失败 → warn 跳过，不影响其余工具与节点执行。
 */
export async function resolveMcpTools(
  activeGroups: MergedGroups | undefined,
  pool: McpServerPool | undefined,
  namespace: string,
  warn: (msg: string, data?: unknown) => void = defaultWarn,
): Promise<HNFlowTool[]> {
  if (activeGroups === undefined || activeGroups.mcps.length === 0 || pool === undefined) {
    return [];
  }
  const tools: HNFlowTool[] = [];
  for (const merged of activeGroups.mcps) {
    const config = parseMcpServerConfig(merged);
    if (config === undefined) {
      warn(`功能组 MCP 配置非法：${merged.name}（command 缺失或非字符串），跳过`, {
        kind: "mcp_config_invalid",
        name: merged.name,
        sourceGuid: merged.sourceGuid,
      });
      continue;
    }
    let session: McpSession;
    try {
      session = await pool.acquire(config);
    } catch (error) {
      warn(`功能组 MCP 启动失败：${merged.name}（${errorMsg(error)}），跳过`, {
        kind: "mcp_acquire_failed",
        name: merged.name,
        sourceGuid: merged.sourceGuid,
      });
      continue;
    }
    const mcpName = namespace === "" ? merged.name : `${namespace}.${merged.name}`;
    try {
      tools.push(...(await discoverMcpTools(sessionToToolHandle(session), mcpName)));
    } catch (error) {
      warn(`功能组 MCP 工具发现失败：${merged.name}（${errorMsg(error)}），跳过`, {
        kind: "mcp_discover_failed",
        name: merged.name,
        sourceGuid: merged.sourceGuid,
      });
    }
  }
  return tools;
}
