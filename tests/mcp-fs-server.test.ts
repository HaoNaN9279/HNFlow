// 文件系统 MCP Server 单测（v0.5.0 T6）：import 模块直接测纯函数
// （import.meta.main guard 保证被 import 时不启动 server）。
// 覆盖：resolveInside（../ 与绝对路径逃逸拒绝）、listDir/readText/statEntry/writeText、
// 大小上限（read ≤64KB / write ≤1MB）、rootDir 缺失由 zod 必填校验（端到端测）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FS_MAX_READ_BYTES,
  FS_MAX_WRITE_BYTES,
  listDir,
  readText,
  resolveInside,
  statEntry,
  writeText,
} from "../src/mcp/servers/fs-server.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hnflow-fs-unit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveInside（路径穿越防护）", () => {
  test("相对路径与空路径 → 位于 rootDir 内", () => {
    expect(resolveInside(root, "a/b.txt")).toBe(join(root, "a", "b.txt"));
    expect(resolveInside(root, "")).toBe(root);
  });

  test("../ 穿越 → undefined（拒绝）", () => {
    expect(resolveInside(root, "../escape.txt")).toBeUndefined();
    expect(resolveInside(root, "a/../../escape.txt")).toBeUndefined();
  });

  test("绝对路径逃逸 → undefined（拒绝）", () => {
    expect(resolveInside(root, join(tmpdir(), "outside.txt"))).toBeUndefined();
  });
});

describe("listDir / statEntry", () => {
  test("listDir 返回排序条目（文件/目录类型）", async () => {
    await writeFile(join(root, "b.txt"), "b", "utf8");
    await writeFile(join(root, "a.txt"), "a", "utf8");
    const entries = await listDir(root);
    expect(entries).toEqual([
      { name: "a.txt", type: "file" },
      { name: "b.txt", type: "file" },
    ]);
  });

  test("listDir 子目录 path 定位", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "c.txt"), "c", "utf8");
    const entries = await listDir(root, "sub");
    expect(entries).toEqual([{ name: "c.txt", type: "file" }]);
  });

  test("listDir 路径穿越 → 拒绝", async () => {
    await expect(listDir(root, "../")).rejects.toThrow(/路径逃逸拒绝/);
  });

  test("statEntry 返回类型/大小", async () => {
    await writeFile(join(root, "a.txt"), "hello", "utf8");
    const info = await statEntry(root, "a.txt");
    expect(info.type).toBe("file");
    expect(info.size).toBe(5);
  });
});

describe("readText", () => {
  test("读取文本内容", async () => {
    await writeFile(join(root, "a.txt"), "hello", "utf8");
    expect(await readText(root, "a.txt")).toBe("hello");
  });

  test("超过 64KB → 拒绝", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(FS_MAX_READ_BYTES + 1), "utf8");
    await expect(readText(root, "big.txt")).rejects.toThrow(/超过 .* 字节上限/);
  });

  test("路径穿越 → 拒绝", async () => {
    await expect(readText(root, "../secret.txt")).rejects.toThrow(/路径逃逸拒绝/);
  });
});

describe("writeText", () => {
  test("写文件成功（父目录自动创建）并返回字节数", async () => {
    const result = await writeText(root, "sub/b.txt", "world");
    expect(result.bytes).toBe(5);
    expect(await readText(root, "sub/b.txt")).toBe("world");
  });

  test("超过 1MB → 拒绝（不落盘）", async () => {
    await expect(
      writeText(root, "big.txt", "x".repeat(FS_MAX_WRITE_BYTES + 1)),
    ).rejects.toThrow(/超过 .* 字节上限/);
  });

  test("路径穿越 → 拒绝（不落盘）", async () => {
    await expect(writeText(root, "../outside.txt", "x")).rejects.toThrow(/路径逃逸拒绝/);
    await expect(writeText(root, join(tmpdir(), "outside.txt"), "x")).rejects.toThrow(/路径逃逸拒绝/);
  });
});
