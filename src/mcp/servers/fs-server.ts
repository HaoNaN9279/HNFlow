// 文件系统 MCP Server（v0.5.0 T6）：白名单目录内的只读/受限写工具。
// 工具：fs_list / fs_read（≤64KB）/ fs_stat / fs_write（≤1MB，仅白名单目录内）。
// 安全模型：每次调用必须传 rootDir（授权根目录，zod 必填校验缺省拒绝）；
// path 解析后必须仍位于 rootDir 内，../ 与绝对路径逃逸一律拒绝。
// 启动方式：bun run src/mcp/servers/fs-server.ts（import.meta.main 时连接 stdio）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import * as z from "zod/v4";

/** fs_read 文件大小上限（字节）。 */
export const FS_MAX_READ_BYTES = 64 * 1024;
/** fs_write 内容大小上限（字节）。 */
export const FS_MAX_WRITE_BYTES = 1024 * 1024;

/** 安全路径解析：target 必须位于 rootDir 内（含 rootDir 自身），否则返回 undefined。 */
export function resolveInside(rootDir: string, path: string): string | undefined {
  const root = resolve(rootDir);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return undefined;
  }
  return target;
}

/** 目录条目：名称 + 类型（directory/file）。 */
export interface FsDirEntry {
  readonly name: string;
  readonly type: string;
}

/** 文件信息：类型 + 大小 + 修改时间（毫秒）。 */
export interface FsStatInfo {
  readonly type: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** 列出 rootDir 内目录条目（path 省略时列出 rootDir 自身），按名称排序。 */
export async function listDir(rootDir: string, path = ""): Promise<FsDirEntry[]> {
  const target = resolveInside(rootDir, path);
  if (target === undefined) {
    throw new Error(`路径逃逸拒绝：${path} 不在 rootDir 内`);
  }
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 读取文本文件：超过 maxBytes 拒绝（防读大文件刷爆内存）。 */
export async function readText(
  rootDir: string,
  path: string,
  maxBytes = FS_MAX_READ_BYTES,
): Promise<string> {
  const target = resolveInside(rootDir, path);
  if (target === undefined) {
    throw new Error(`路径逃逸拒绝：${path} 不在 rootDir 内`);
  }
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error(`fs_read 拒绝：${path} 不是常规文件`);
  }
  if (info.size > maxBytes) {
    throw new Error(`fs_read 拒绝：文件 ${info.size} 字节，超过 ${maxBytes} 字节上限`);
  }
  return readFile(target, "utf8");
}

/** 文件/目录信息。 */
export async function statEntry(rootDir: string, path: string): Promise<FsStatInfo> {
  const target = resolveInside(rootDir, path);
  if (target === undefined) {
    throw new Error(`路径逃逸拒绝：${path} 不在 rootDir 内`);
  }
  const info = await stat(target);
  return {
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** 写文本文件：rootDir 内 + 内容 ≤ maxBytes；父目录自动创建。 */
export async function writeText(
  rootDir: string,
  path: string,
  content: string,
  maxBytes = FS_MAX_WRITE_BYTES,
): Promise<{ bytes: number }> {
  const target = resolveInside(rootDir, path);
  if (target === undefined) {
    throw new Error(`路径逃逸拒绝：${path} 不在 rootDir 内`);
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`fs_write 拒绝：内容 ${bytes} 字节，超过 ${maxBytes} 字节上限`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return { bytes };
}

const server = new McpServer({
  name: "hnflow-fs",
  version: "0.5.0",
});

// fs_list：列目录条目。
server.registerTool(
  "fs_list",
  {
    description: "列出目录条目（rootDir 内；path 省略列 rootDir 自身）",
    inputSchema: { rootDir: z.string(), path: z.string().optional() },
  },
  async ({ rootDir, path }) => {
    const entries = await listDir(rootDir, path ?? "");
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  },
);

// fs_read：读文本文件（≤64KB）。
server.registerTool(
  "fs_read",
  {
    description: "读取文本文件（≤64KB；仅 rootDir 内）",
    inputSchema: { rootDir: z.string(), path: z.string() },
  },
  async ({ rootDir, path }) => ({
    content: [{ type: "text", text: await readText(rootDir, path) }],
  }),
);

// fs_stat：文件/目录信息。
server.registerTool(
  "fs_stat",
  {
    description: "文件/目录信息（仅 rootDir 内）",
    inputSchema: { rootDir: z.string(), path: z.string() },
  },
  async ({ rootDir, path }) => ({
    content: [{ type: "text", text: JSON.stringify(await statEntry(rootDir, path)) }],
  }),
);

// fs_write：写文本文件（≤1MB，仅 rootDir 内，父目录自动创建）。
server.registerTool(
  "fs_write",
  {
    description: "写文本文件（≤1MB；仅 rootDir 内，父目录自动创建）",
    inputSchema: { rootDir: z.string(), path: z.string(), content: z.string() },
  },
  async ({ rootDir, path, content }) => ({
    content: [{ type: "text", text: JSON.stringify(await writeText(rootDir, path, content)) }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 直接执行（bun run）时连接 stdio；被 import（单测）时不启动，仅导出纯函数。
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("fs-server 启动失败:", error);
    process.exit(1);
  });
}
