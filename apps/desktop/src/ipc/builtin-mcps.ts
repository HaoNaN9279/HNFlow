// 内建 MCP Server 注册清单（v0.5.0 T6）：git / fs / system 三个真实 MCP Server。
// 桌面端消费：将清单转成功能组 mcp.json（command=bun + args=[run, <绝对入口>]），
// 写入用户功能组库或注入 activeGroups.mcps；mcpTool 节点亦可直接用 serverName + mcpConfig。
// 入口为 src/mcp/servers/ 下 ts 文件，MCP 子进程由 bun 运行（与测试 fixtures 一致：bun run <入口>）。
//
// 接入方式（二选一，当前为方案 2 已实现：独立 mcp.json 清单）：
//   1) seed 功能组：在 seed-groups.ts 的 SEED_GROUPS 增加内建组，mcps 指向 builtinMcpConfig(绝对入口)；
//      缺点：改动会波及现有 groups 测试断言（demo 为唯一种子组）。
//   2) 独立清单（本文件）：调用方在起 MCP 池前，用 builtinMcpConfig(绝对入口) 生成配置，
//      并入 activeGroups.mcps（AI 节点）或 mcpTool 节点的 mcpConfig。
// 绝对入口解析：开发时 join(process.cwd(), entry)；打包后基于 app.getAppPath()。
export interface BuiltinMcpTool {
  readonly name: string;
  readonly description: string;
}

export interface BuiltinMcpServerInfo {
  readonly serverName: string;
  readonly description: string;
  /** 相对仓库根入口（需调用方解析为绝对路径后传给 builtinMcpConfig）。 */
  readonly entry: string;
  readonly tools: readonly BuiltinMcpTool[];
}

/** 内建 MCP Server 清单（serverName + 工具清单，供桌面注册/文档展示）。 */
export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServerInfo[] = [
  {
    serverName: "git",
    description: "Git 仓库只读查询与受限暂存（CLI 回退：git 不可用/非仓库时返回可手动执行的命令）",
    entry: "src/mcp/servers/git-server.ts",
    tools: [
      { name: "git_status", description: "git status --short（cwd 必填）" },
      { name: "git_log", description: "git log --oneline -n N（最近 N 条提交）" },
      { name: "git_branch", description: "git branch --show-current（当前分支名）" },
      { name: "git_diff", description: "git diff --stat HEAD（可选路径限定）" },
      { name: "git_add", description: "git add 指定路径（仅工作区已存在路径）" },
    ],
  },
  {
    serverName: "fs",
    description: "白名单目录内文件系统操作（list/read/stat/write）",
    entry: "src/mcp/servers/fs-server.ts",
    tools: [
      { name: "fs_list", description: "列目录条目（rootDir 必填，path 省略列 rootDir 自身）" },
      { name: "fs_read", description: "读文本文件（≤64KB，仅 rootDir 内）" },
      { name: "fs_stat", description: "文件/目录信息（仅 rootDir 内）" },
      { name: "fs_write", description: "写文本文件（≤1MB，仅 rootDir 内，父目录自动创建）" },
    ],
  },
  {
    serverName: "system",
    description: "系统信息（时间/平台/白名单环境变量/进程运行时长）",
    entry: "src/mcp/servers/system-server.ts",
    tools: [
      { name: "sys_time", description: "当前时间（ISO 8601）" },
      { name: "sys_platform", description: "平台/架构/Node 版本" },
      { name: "sys_env", description: "白名单环境变量查询（防泄露敏感项）" },
      { name: "sys_uptime", description: "进程运行时长（毫秒）与启动时间" },
    ],
  },
];

/** 生成 mcp.json 配置：command=bun + args=[run, <入口>]（entry 应为绝对路径）。 */
export function builtinMcpConfig(entry: string): Readonly<{ command: string; args: readonly string[] }> {
  return { command: "bun", args: ["run", entry] };
}
