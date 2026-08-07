// 内建 MCP Server 端到端测试（v0.5.0 T6）：经 McpServerPool 真实启动 3 个 server 子进程
// （git/fs/system），照 echo-server 测试模式（command=bun + args=[run, <server 文件>]）。
// system-server：无外部依赖；git-server：临时 git 仓库（init/commit）；fs-server：临时目录。
// 子进程清理：afterEach 统一 dispose 进程池，严禁残留长驻子进程。
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerPool } from "../src/mcp/pool.js";
import type { McpServerConfig } from "../src/mcp/types.js";

/** 已创建的进程池，逐个测试后统一 dispose 清理。 */
const pools: McpServerPool[] = [];

function createPool(): McpServerPool {
  const pool = new McpServerPool();
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  while (pools.length > 0) {
    const pool = pools.pop();
    if (pool !== undefined) {
      await pool.dispose();
    }
  }
});

const SERVER_DIR = join(process.cwd(), "src", "mcp", "servers");

function serverConfig(name: string): McpServerConfig {
  return { name, command: "bun", args: ["run", join(SERVER_DIR, `${name}-server.ts`)] };
}

/** 判断 SDK 原始返回是否带 isError 标志。 */
function isErrorRaw(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || !("isError" in raw)) {
    return false;
  }
  return raw.isError === true;
}

/** 测试夹具执行 git 命令（环境无 git 时抛错）。 */
function runGitCli(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function probeGit(): Promise<boolean> {
  try {
    await runGitCli(process.cwd(), ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = await probeGit();

describe("system-server 端到端（无外部依赖）", () => {
  test("sys_time / sys_platform / sys_env / sys_uptime 返回正确", async () => {
    const pool = createPool();
    const session = await pool.acquire(serverConfig("system"));
    expect(session.listTools().map((t) => t.name).sort()).toEqual([
      "sys_env",
      "sys_platform",
      "sys_time",
      "sys_uptime",
    ]);

    const time = await session.callTool("sys_time", {});
    expect(time.text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(isErrorRaw(time.raw)).toBe(false);

    const platform = JSON.parse((await session.callTool("sys_platform", {})).text) as {
      platform: string;
      arch: string;
      node: string;
    };
    expect(platform.platform).toBe(process.platform);
    expect(platform.arch).toBe(process.arch);
    expect(platform.node.startsWith("v")).toBe(true);

    const envName = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const env = JSON.parse((await session.callTool("sys_env", { name: envName })).text) as {
      allowed: boolean;
      value: string | null;
    };
    expect(env.allowed).toBe(true);
    expect(env.value).toBe(process.env[envName] ?? null);
    const denied = JSON.parse(
      (await session.callTool("sys_env", { name: "HNFLOW_SUPER_SECRET_XYZ" })).text,
    ) as { allowed: boolean };
    expect(denied.allowed).toBe(false);

    const uptime = JSON.parse((await session.callTool("sys_uptime", {})).text) as {
      uptimeMs: number;
      startedAt: string;
    };
    expect(uptime.uptimeMs).toBeGreaterThan(0);
    expect(new Date(uptime.startedAt).getTime()).toBeGreaterThan(0);
  }, 20000);
});

describe("git-server 端到端（临时 git 仓库）", () => {
  test("git_status / git_log / git_branch / git_diff / git_add 正确", async () => {
    if (!GIT_AVAILABLE) return;
    const repoDir = await mkdtemp(join(tmpdir(), "hnflow-git-e2e-"));
    try {
      await runGitCli(repoDir, ["init", "-q"]);
      await runGitCli(repoDir, ["config", "user.email", "test@example.com"]);
      await runGitCli(repoDir, ["config", "user.name", "test"]);
      await writeFile(join(repoDir, "a.txt"), "hello\n", "utf8");
      await runGitCli(repoDir, ["add", "a.txt"]);
      await runGitCli(repoDir, ["commit", "-m", "init", "-q"]);
      await writeFile(join(repoDir, "b.txt"), "world\n", "utf8"); // 未跟踪

      const pool = createPool();
      const session = await pool.acquire(serverConfig("git"));
      expect(session.listTools().map((t) => t.name).sort()).toEqual([
        "git_add",
        "git_branch",
        "git_diff",
        "git_log",
        "git_status",
      ]);

      // git_status：未跟踪 b.txt 可见
      const status = await session.callTool("git_status", { cwd: repoDir });
      expect(isErrorRaw(status.raw)).toBe(false);
      expect(status.text).toContain("b.txt");

      // git_log：提交信息
      const log = await session.callTool("git_log", { cwd: repoDir, n: 5 });
      expect(log.text).toContain("init");

      // git_branch：当前分支非空
      const branch = await session.callTool("git_branch", { cwd: repoDir });
      expect(branch.text.length).toBeGreaterThan(0);

      // git_diff：--stat HEAD 正常（无 fallback）
      const diff = await session.callTool("git_diff", { cwd: repoDir });
      expect(isErrorRaw(diff.raw)).toBe(false);
      expect(diff.text).not.toContain("fallback");

      // git_add：已存在路径成功；-A 拒绝（isError）
      const addOk = await session.callTool("git_add", { cwd: repoDir, path: "b.txt" });
      expect(isErrorRaw(addOk.raw)).toBe(false);
      const addBad = await session.callTool("git_add", { cwd: repoDir, path: "-A" });
      expect(isErrorRaw(addBad.raw)).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  }, 30000);

  test("非仓库目录 → CLI 回退结构化结果（fallback + reason）", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "hnflow-git-e2e-norepo-"));
    try {
      const pool = createPool();
      const session = await pool.acquire(serverConfig("git"));
      const result = await session.callTool("git_status", { cwd: plainDir });
      expect(isErrorRaw(result.raw)).toBe(false); // 回退是正常结果，非错误
      const parsed = JSON.parse(result.text) as { fallback: string; reason: string };
      expect(parsed.fallback).toBe("git status --short");
      expect(parsed.reason).toContain("git");
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  }, 20000);
});

describe("fs-server 端到端（临时目录）", () => {
  test("fs_list / fs_read / fs_stat / fs_write 正确", async () => {
    const root = await mkdtemp(join(tmpdir(), "hnflow-fs-e2e-"));
    try {
      await writeFile(join(root, "a.txt"), "hello", "utf8");
      const pool = createPool();
      const session = await pool.acquire(serverConfig("fs"));
      expect(session.listTools().map((t) => t.name).sort()).toEqual([
        "fs_list",
        "fs_read",
        "fs_stat",
        "fs_write",
      ]);

      const list = JSON.parse((await session.callTool("fs_list", { rootDir: root })).text) as {
        name: string;
        type: string;
      }[];
      expect(list).toEqual([{ name: "a.txt", type: "file" }]);

      const read = await session.callTool("fs_read", { rootDir: root, path: "a.txt" });
      expect(read.text).toBe("hello");

      const stat = JSON.parse((await session.callTool("fs_stat", { rootDir: root, path: "a.txt" })).text) as {
        type: string;
        size: number;
      };
      expect(stat.type).toBe("file");
      expect(stat.size).toBe(5);

      const written = await session.callTool("fs_write", {
        rootDir: root,
        path: "sub/b.txt",
        content: "world",
      });
      expect(JSON.parse(written.text).bytes).toBe(5);
      const readBack = await session.callTool("fs_read", { rootDir: root, path: "sub/b.txt" });
      expect(readBack.text).toBe("world");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  test("路径穿越（../ 与绝对路径逃逸）与 rootDir 缺失 → 拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "hnflow-fs-e2e-sec-"));
    try {
      const pool = createPool();
      const session = await pool.acquire(serverConfig("fs"));

      const escapeRel = await session.callTool("fs_read", { rootDir: root, path: "../secret.txt" });
      expect(isErrorRaw(escapeRel.raw)).toBe(true);

      const escapeAbs = await session.callTool("fs_read", {
        rootDir: root,
        path: join(tmpdir(), "..", "hnflow-outside.txt"),
      });
      expect(isErrorRaw(escapeAbs.raw)).toBe(true);

      const escapeWrite = await session.callTool("fs_write", {
        rootDir: root,
        path: "../escape.txt",
        content: "x",
      });
      expect(isErrorRaw(escapeWrite.raw)).toBe(true);

      // rootDir 缺失：zod 必填校验拒绝
      const noRoot = await session.callTool("fs_read", { path: "a.txt" } as Record<string, unknown>);
      expect(isErrorRaw(noRoot.raw)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
