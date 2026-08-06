// MCP 工具发现与转换层：tools/list 原始工具 → HNFlowTool，供 AI 节点消费。
// 本文件仅依赖会话最小接口 McpToolHandle，不绑定具体 SDK Client 实现。
import * as z from "zod/v4";
import type { HNFlowTool } from "../ai/types.js";

/** MCP 会话最小接口：由上层会话实现（如 SDK Client 适配器）。 */
export interface McpToolHandle {
  /** 列出会话暴露的全部工具（原始描述）。 */
  listTools(): Promise<McpListToolsResult>;
  /** 调用工具：name 为 MCP 原始工具名，args 为参数对象。 */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** tools/list 结果的最小视图。 */
export interface McpListToolsResult {
  tools: McpToolDescriptor[];
}

/** 单个 MCP 工具描述（tools/list 返回 Tool 的窄化视图）。 */
export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema: McpInputSchema;
}

/** MCP 工具参数 JSON schema（MCP 规范要求根为 object）。 */
export interface McpInputSchema {
  type: "object";
  properties?: unknown;
  required?: string[] | undefined;
}

/** callTool 结果的最小视图。 */
export interface McpCallToolResult {
  content: McpContentItem[];
  isError?: boolean | undefined;
}

/** callTool 结果的内容块：只读取 text 块，其余类型忽略。 */
export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * JSON schema 属性 → zod。支持 string/number/integer/boolean/array/object；
 * 其它/未知类型退回宽松 record，保证工具始终可被调用。
 */
function jsonSchemaToZodType(schema: unknown): z.ZodType {
  if (schema === null || typeof schema !== "object") {
    return z.record(z.string(), z.unknown());
  }
  const record = schema as Record<string, unknown>;
  switch (record["type"]) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZodType(record["items"]));
    case "object":
      return jsonSchemaToZodObject(record);
    default:
      return z.record(z.string(), z.unknown());
  }
}

/** JSON schema object → ZodObject：properties 逐字段映射，required 标记必填。 */
function jsonSchemaToZodObject(schema: unknown): z.ZodObject<z.ZodRawShape> {
  if (schema === null || typeof schema !== "object") {
    return z.object({});
  }
  const record = schema as Record<string, unknown>;
  const requiredSet = new Set<string>();
  const requiredRaw = record["required"];
  if (Array.isArray(requiredRaw)) {
    for (const item of requiredRaw) {
      if (typeof item === "string") {
        requiredSet.add(item);
      }
    }
  }
  const shape: Record<string, z.ZodType> = {};
  const propertiesRaw = record["properties"];
  if (propertiesRaw !== null && typeof propertiesRaw === "object") {
    for (const [key, propSchema] of Object.entries(
      propertiesRaw as Record<string, unknown>,
    )) {
      const zodType = jsonSchemaToZodType(propSchema);
      shape[key] = requiredSet.has(key) ? zodType : zodType.optional();
    }
  }
  return z.object(shape);
}

/** 提取 callTool 结果中全部 text 块的文本，按顺序拼接。 */
function extractText(content: McpContentItem[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

/** 判断未知值是否为 MCP CallToolResult 形状（含 content 数组）。 */
function isMcpCallToolResult(raw: unknown): raw is McpCallToolResult {
  if (raw === null || typeof raw !== "object") {
    return false;
  }
  return Array.isArray((raw as Record<string, unknown>)["content"]);
}

/** 规范化 callTool 结果：isError 抛中文错误，成功时返回拼接文本。 */
function normalizeCallToolResult(raw: unknown): unknown {
  if (isMcpCallToolResult(raw)) {
    if (raw.isError === true) {
      const detail = extractText(raw.content);
      throw new Error(`MCP 工具调用失败: ${detail === "" ? "未知错误" : detail}`);
    }
    return extractText(raw.content);
  }
  // 非标准形状（如 mock 直接返回字符串）：字符串原样返回，对象 JSON 序列化。
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/** MCP 工具描述 + 会话句柄 → HNFlowTool（fullName 由上层传入命名空间名）。 */
export function mcpToolToHNFlowTool(
  handle: McpToolHandle,
  mcpTool: McpToolDescriptor,
  fullName: string,
): HNFlowTool {
  return {
    name: fullName,
    description: mcpTool.description ?? mcpTool.name,
    parameters: jsonSchemaToZodObject(mcpTool.inputSchema),
    handler: async (input) => {
      const raw = await handle.callTool(mcpTool.name, input);
      return normalizeCallToolResult(raw);
    },
  };
}

/** 从会话发现全部工具：listTools → 逐个转换，完整名 = `<mcpName>.<toolName>`。 */
export async function discoverMcpTools(
  handle: McpToolHandle,
  mcpName: string,
): Promise<HNFlowTool[]> {
  const { tools } = await handle.listTools();
  return tools.map((mcpTool) => {
    const fullName = mcpName === "" ? mcpTool.name : `${mcpName}.${mcpTool.name}`;
    return mcpToolToHNFlowTool(handle, mcpTool, fullName);
  });
}
