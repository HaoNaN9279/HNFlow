/**
 * MCP 进程池类型定义。
 *
 * 类型集中放置，session.ts / pool.ts 共用，避免循环依赖。
 */

/** MCP Server 启动配置。 */
export interface McpServerConfig {
  /** 池内唯一标识：同 name 的 Server 复用同一子进程。 */
  name: string;
  /** 启动可执行文件（如 bun、node 或绝对路径）。 */
  command: string;
  /** 传给可执行文件的参数。 */
  args?: string[];
  /** 额外环境变量（缺省由 SDK 继承安全环境变量）。 */
  env?: Record<string, string>;
  /** 子进程工作目录。 */
  cwd?: string;
  /**
   * 是否状态型 Server：状态保存在进程内存中。
   * 缺省 false（无状态）——崩溃后重建新进程无副作用；
   * true 时崩溃重启即状态自然归零。
   */
  stateful?: boolean;
}

/** 会话生命周期状态。 */
export type McpSessionStatus = "connecting" | "ready" | "dead" | "released";

/** 工具元数据（tools/list 投影：name/description/inputSchema）。 */
export interface McpToolInfo {
  /** 工具名。 */
  name: string;
  /** 工具描述（Server 可能缺省）。 */
  description: string | undefined;
  /** 输入 JSON Schema。 */
  inputSchema: Record<string, unknown>;
}

/** callTool 规范化返回：结构化 content 提取 + 文本拼接。 */
export interface McpCallResult {
  /** 全部文本 content 拼接结果（无文本时为空字符串）。 */
  text: string;
  /** SDK 原始返回（含 content / structuredContent / isError 等字段）。 */
  raw: unknown;
}

/** 会话句柄：进程池向调用方暴露的最小接口（便于测试注入 mock）。 */
export interface McpSessionHandle {
  readonly config: McpServerConfig;
  /** 当前生命周期状态。 */
  getStatus(): McpSessionStatus;
  /** 工具原始列表（name/description/inputSchema）。 */
  listTools(): McpToolInfo[];
  /** 调用工具，返回规范化结果。 */
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** 健康检查：调用失败会标记 dead。 */
  ping(): Promise<boolean>;
  /** 子进程 pid（未启动或已退出时为 null）。 */
  getPid(): number | null;
  /** 幂等关闭会话。 */
  close(): Promise<void>;
}
