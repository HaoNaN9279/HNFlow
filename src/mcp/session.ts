/**
 * MCP 会话：包装 SDK Client + StdioClientTransport。
 *
 * 职责：
 *  - connect() 建连并缓存工具列表（tools/list）
 *  - callTool() 规范化返回（结构化 content 提取 + 文本拼接）
 *  - 崩溃检测：子进程退出 → transport onclose → 标记 dead
 *  - close() 幂等释放（主动关闭不标记 dead）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  McpCallResult,
  McpServerConfig,
  McpSessionHandle,
  McpSessionStatus,
  McpToolInfo,
} from "./types.js";

/** SDK callTool 实际返回类型（普通结果 | task-based toolResult 联合）。 */
type CallToolOutcome = Awaited<ReturnType<Client["callTool"]>>;

/** 从调用结果提取纯文本：text content 拼接；task 分支序列化。 */
function extractText(result: CallToolOutcome): string {
  if ("toolResult" in result) {
    return JSON.stringify(result.toolResult);
  }
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === "text") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

/** 一条 MCP 会话 = 一个 Server 子进程。 */
export class McpSession implements McpSessionHandle {
  readonly config: McpServerConfig;
  private readonly client: Client;
  /** 崩溃重建时复用的工具缓存（无状态场景由进程池注入，跳过重复 listTools）。 */
  private readonly initTools: readonly McpToolInfo[];
  private transport: StdioClientTransport | undefined;
  private tools: McpToolInfo[] = [];
  private status: McpSessionStatus = "connecting";
  /** 主动关闭标志：为 true 时 transport onclose 不标记 dead。 */
  private closedByPool = false;

  constructor(config: McpServerConfig, initTools?: readonly McpToolInfo[]) {
    this.config = config;
    this.initTools = initTools ?? [];
    this.client = new Client({ name: "hnflow-mcp-pool", version: "0.4.2" });
  }

  /** 建立连接并缓存工具列表；进程意外退出会触发崩溃标记。 */
  async connect(): Promise<void> {
    if (this.status === "ready" || this.status === "released") {
      return;
    }
    if (this.status === "dead") {
      throw new Error(`MCP 会话 ${this.config.name} 已崩溃，请重新 acquire 重建`);
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      ...(this.config.args !== undefined ? { args: this.config.args } : {}),
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
      ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
    });
    this.transport = transport;
    // 子进程退出（崩溃）→ onclose 触发 → 标记 dead；主动关闭时跳过。
    transport.onclose = () => {
      if (!this.closedByPool) {
        this.markDead();
      }
    };
    await this.client.connect(transport);
    this.tools =
      this.initTools.length > 0 ? [...this.initTools] : await this.discoverTools();
    this.status = "ready";
  }

  /** 工具原始列表（name/description/inputSchema）。 */
  listTools(): McpToolInfo[] {
    return this.tools;
  }

  /** 调用工具，返回规范化结果（结构化 content 提取 + 文本拼接）。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (this.status !== "ready") {
      throw new Error(`MCP 会话 ${this.config.name} 不可用（状态：${this.status}）`);
    }
    const raw = await this.client.callTool({ name, arguments: args });
    return { text: extractText(raw), raw };
  }

  /** 健康检查：调用失败标记 dead（状态型 Server 执行前可用）。 */
  async ping(): Promise<boolean> {
    if (this.status !== "ready") {
      return false;
    }
    try {
      await this.client.ping();
      return true;
    } catch {
      this.markDead();
      return false;
    }
  }

  /** 会话状态。 */
  getStatus(): McpSessionStatus {
    return this.status;
  }

  /** 子进程 pid（transport 未启动或已关闭时为 null）。 */
  getPid(): number | null {
    return this.transport?.pid ?? null;
  }

  /** 进程是否存活可用。 */
  isAlive(): boolean {
    return this.status === "ready";
  }

  /** 幂等关闭：主动释放，不标记 dead。 */
  async close(): Promise<void> {
    if (this.status === "released") {
      return;
    }
    this.closedByPool = true;
    this.status = "released";
    const transport = this.transport;
    this.transport = undefined;
    try {
      await this.client.close();
    } catch {
      // client 可能已随进程退出而断开，忽略关闭异常
    }
    if (transport !== undefined) {
      delete transport.onclose;
      try {
        await transport.close();
      } catch {
        // 进程已退出时 transport.close 可能抛错，忽略
      }
    }
  }

  /** 崩溃标记：进程意外退出时由 onclose 触发。 */
  private markDead(): void {
    if (this.status === "ready" || this.status === "connecting") {
      this.status = "dead";
      this.transport = undefined;
    }
  }

  /** tools/list 拉取并投影为 McpToolInfo。 */
  private async discoverTools(): Promise<McpToolInfo[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}
