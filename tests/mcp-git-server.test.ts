// Git MCP Server 单测（v0.5.0 T6）：import 模块直接测纯函数
// （import.meta.main guard 保证被 import 时不启动 server）。
// 覆盖：runGit 成功/失败（CLI 回退结构化结果）、describeGitError 三类原因、
// validateAddPath 白名单（已存在路径通过；不存在/-A 拒绝）。
// git 不可用的成功路径无法在本机模拟（git 在 PATH），由 describeGitError 的 ENOENT 映射覆盖。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeGitError, runGit, validateAddPath } from "../src/mcp/servers/git-server.js";

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

/** git 是否可用（探测一次）。 */
async function probeGit(): Promise<boolean> {
  try {
    await runGitCli(process.cwd(), ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** 临时 git 仓库夹具：init + 提交 a.txt。 */
async function makeRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "hnflow-git-unit-"));
  await runGitCli(repoDir, ["init", "-q"]);
  await runGitCli(repoDir, ["config", "user.email", "test@example.com"]);
  await runGitCli(repoDir, ["config", "user.name", "test"]);
  await writeFile(join(repoDir, "a.txt"), "hello\n", "utf8");
  await runGitCli(repoDir, ["add", "a.txt"]);
  await runGitCli(repoDir, ["commit", "-m", "init", "-q"]);
  return repoDir;
}

const GIT_AVAILABLE = await probeGit();
let repoDir: string;

beforeEach(async () => {
  if (GIT_AVAILABLE) {
    repoDir = await makeRepo();
  }
});

afterEach(async () => {
  if (GIT_AVAILABLE) {
    await rm(repoDir, { recursive: true, force: true });
  }
});

describe("runGit（CLI 回退）", () => {
  test("成功：已提交仓库 status --short 为空且 ok:true", async () => {
    if (!GIT_AVAILABLE) return;
    const result = await runGit(repoDir, ["status", "--short"]);
    expect(result.ok).toBe(true);
    expect(result.out).toBe("");
  });

  test("成功：git_log 返回提交信息", async () => {
    if (!GIT_AVAILABLE) return;
    const result = await runGit(repoDir, ["log", "--oneline", "-n", "5"]);
    expect(result.ok).toBe(true);
    expect(result.out).toContain("init");
  });

  test("非仓库 → ok:false 且返回 CLI 回退结构化信息", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "hnflow-git-norepo-"));
    try {
      const result = await runGit(plainDir, ["status", "--short"]);
      expect(result.ok).toBe(false);
      expect(result.fallback).toBe("git status --short");
      expect(result.reason).toContain("git");
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});

describe("describeGitError（失败原因分类）", () => {
  test("ENOENT → git 不可用", () => {
    const reason = describeGitError({ code: "ENOENT", message: "spawn git ENOENT" }, "");
    expect(reason).toContain("git 不可用");
  });

  test("stderr 含 not a git repository → 非 git 仓库", () => {
    const reason = describeGitError(
      { code: 128, message: "Command failed" },
      "fatal: not a git repository (or any of the parent directories): .git",
    );
    expect(reason).toContain("非 git 仓库");
  });

  test("其它非零退出 → git 命令失败（含退出码与 stderr 首行）", () => {
    const reason = describeGitError({ code: 2, message: "Command failed" }, "usage: git log [<options>]");
    expect(reason).toContain("git 命令失败");
    expect(reason).toContain("退出码 2");
    expect(reason).toContain("usage: git log");
  });
});

describe("validateAddPath（git add 白名单）", () => {
  test("已存在文件 → 通过（返回 undefined）", async () => {
    if (!GIT_AVAILABLE) return;
    await writeFile(join(repoDir, "b.txt"), "world\n", "utf8");
    expect(await validateAddPath(repoDir, "b.txt")).toBeUndefined();
  });

  test("不存在路径 → 拒绝", async () => {
    if (!GIT_AVAILABLE) return;
    const reason = await validateAddPath(repoDir, "not-exist.txt");
    expect(reason).toContain("不存在");
  });

  test("选项参数（-A / --all）→ 拒绝", async () => {
    if (!GIT_AVAILABLE) return;
    const reason = await validateAddPath(repoDir, "-A");
    expect(reason).toContain("拒绝");
    const reasonAll = await validateAddPath(repoDir, "--all");
    expect(reasonAll).toContain("拒绝");
  });
});
