// Git MCP Server（v0.5.0 T6）：git 只读查询 + 受限暂存。
// 工具：git_status / git_log / git_branch / git_diff / git_add（仅 add 工作区已存在路径）。
// CLI 回退（T7）：git 不可用 / 非仓库 / 命令失败 → 返回结构化结果
// { fallback: "git ...", reason: "..." }，提供可手动执行的命令字符串。
// 安全：cwd 必填（zod 校验，缺省拒绝）；add 拒绝选项参数（-A/--all 等）。
// 启动方式：bun run src/mcp/servers/git-server.ts（import.meta.main 时连接 stdio）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod/v4";

/** git 命令执行结果：成功 out；失败 fallback（可手动执行的 CLI 命令）与 reason。 */
export interface GitExecResult {
  readonly ok: boolean;
  readonly out: string;
  readonly fallback: string;
  readonly reason: string;
}

/** 失败原因分类：git 不可用（ENOENT）/ 非仓库 / 其他命令错误。 */
export function describeGitError(error: unknown, stderr: string): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return "git 不可用：未找到 git 可执行文件（未安装或不在 PATH）";
  }
  if (stderr.includes("not a git repository")) {
    return "非 git 仓库：工作目录不在任何 git 仓库内";
  }
  const codeText = typeof code === "number" ? String(code) : "?";
  const detail = stderr.trim().split("\n")[0] ?? "";
  return `git 命令失败（退出码 ${codeText}）：${detail === "" ? "未知错误" : detail}`;
}

/** 执行单条 git 命令：execFile 带 timeout（防挂起），失败生成 CLI 回退结构化结果。 */
export function runGit(cwd: string, args: readonly string[]): Promise<GitExecResult> {
  const fallback = `git ${args.join(" ")}`;
  return new Promise((settle) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: 10_000, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) {
          settle({ ok: true, out: stdout.trim(), fallback, reason: "" });
          return;
        }
        settle({ ok: false, out: "", fallback, reason: describeGitError(error, stderr) });
      },
    );
  });
}

/** git add 路径校验：拒绝空 / 选项参数（-A/--all 等），并要求路径已存在于工作区。 */
export async function validateAddPath(cwd: string, path: string): Promise<string | undefined> {
  if (path === "" || path.startsWith("-")) {
    return `git add 拒绝：路径 "${path}" 为空或以 - 开头（不允许 -A/--all 等选项）`;
  }
  const target = resolve(cwd, path);
  try {
    const info = await stat(target);
    if (!info.isFile() && !info.isDirectory()) {
      return `git add 拒绝：${path} 不是常规文件或目录`;
    }
  } catch {
    return `git add 拒绝：${path} 不存在于工作区`;
  }
  return undefined;
}

/** 工具结果：git 失败时返回 CLI 回退结构化信息（非 isError，供 AI 直接读取）。 */
function gitResult(result: GitExecResult): CallToolResult {
  if (result.ok) {
    return { content: [{ type: "text", text: result.out }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ fallback: result.fallback, reason: result.reason }) }],
  };
}

const server = new McpServer({
  name: "hnflow-git",
  version: "0.5.0",
});

// git_status：status --short。
server.registerTool(
  "git_status",
  {
    description: "git status --short（工作目录 cwd 必填）",
    inputSchema: { cwd: z.string() },
  },
  async ({ cwd }) => gitResult(await runGit(cwd, ["status", "--short"])),
);

// git_log：log --oneline -n N（最近 N 条提交）。
server.registerTool(
  "git_log",
  {
    description: "git log --oneline -n N（最近 N 条提交）",
    inputSchema: { cwd: z.string(), n: z.number().int().min(1).max(100).optional() },
  },
  async ({ cwd, n }) => gitResult(await runGit(cwd, ["log", "--oneline", "-n", String(n ?? 20)])),
);

// git_branch：branch --show-current（当前分支名）。
server.registerTool(
  "git_branch",
  {
    description: "git branch --show-current（当前分支名）",
    inputSchema: { cwd: z.string() },
  },
  async ({ cwd }) => gitResult(await runGit(cwd, ["branch", "--show-current"])),
);

// git_diff：diff --stat HEAD（可选路径限定）。
server.registerTool(
  "git_diff",
  {
    description: "git diff --stat HEAD（可选路径限定）",
    inputSchema: { cwd: z.string(), path: z.string().optional() },
  },
  async ({ cwd, path }) =>
    gitResult(
      path === undefined
        ? await runGit(cwd, ["diff", "--stat", "HEAD"])
        : await runGit(cwd, ["diff", "--stat", "HEAD", "--", path]),
    ),
);

// git_add：add 指定路径（先校验存在性，拒绝 -A/--all 等危险参数）。
server.registerTool(
  "git_add",
  {
    description: "git add 指定路径（仅工作区已存在路径，拒绝 -A/--all 等选项）",
    inputSchema: { cwd: z.string(), path: z.string() },
  },
  async ({ cwd, path }) => {
    const reason = await validateAddPath(cwd, path);
    if (reason !== undefined) {
      return {
        content: [{ type: "text", text: JSON.stringify({ fallback: "", reason }) }],
        isError: true,
      };
    }
    return gitResult(await runGit(cwd, ["add", "--", path]));
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 直接执行（bun run）时连接 stdio；被 import（单测）时不启动，仅导出纯函数。
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("git-server 启动失败:", error);
    process.exit(1);
  });
}
