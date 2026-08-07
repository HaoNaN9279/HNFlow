// 路径沙箱（v0.9.4）：resolveSandboxPath 边界——沙箱内/自身/../逃逸/绝对路径逃逸/Windows 盘符。
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveSandboxPath, SandboxPathError } from "../src/security/path-sandbox.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

describe("resolveSandboxPath 边界", () => {
  test("沙箱内相对路径 → 解析后绝对路径位于沙箱内", async () => {
    const root = await mkdtemp(join(TEMP_BASE, "hnflow-sb-in-"));
    try {
      expect(resolveSandboxPath(root, "sub/file.txt")).toBe(resolve(root, "sub/file.txt"));
      expect(resolveSandboxPath(root, "a/b/c.txt")).toBe(resolve(root, "a/b/c.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rootDir 自身放行（. 与空串）", async () => {
    const root = await mkdtemp(join(TEMP_BASE, "hnflow-sb-self-"));
    try {
      expect(resolveSandboxPath(root, ".")).toBe(resolve(root));
      expect(resolveSandboxPath(root, "")).toBe(resolve(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("../ 逃逸拒绝 → undefined", async () => {
    const root = await mkdtemp(join(TEMP_BASE, "hnflow-sb-up-"));
    try {
      expect(resolveSandboxPath(root, "../outside.txt")).toBeUndefined();
      expect(resolveSandboxPath(root, "sub/../../x.txt")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("绝对路径逃逸拒绝 → undefined（沙箱外目录）", async () => {
    const base = await mkdtemp(join(TEMP_BASE, "hnflow-sb-abs-"));
    const root = join(base, "sandbox");
    const outside = join(base, "outside.txt");
    try {
      expect(resolveSandboxPath(root, outside)).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("Windows 盘符逃逸拒绝 → undefined", async () => {
    const root = await mkdtemp(join(TEMP_BASE, "hnflow-sb-drv-"));
    try {
      if (process.platform === "win32") {
        expect(resolveSandboxPath(root, "D:\\evil.txt")).toBeUndefined();
        expect(resolveSandboxPath(root, "C:\\Windows\\system32")).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("SandboxPathError 消息", () => {
  test("中文消息含路径与根目录", () => {
    const error = new SandboxPathError("C:\\sandbox", "../x.txt");
    expect(error.message).toBe("路径逃逸沙箱：../x.txt 不在 C:\\sandbox 内");
    expect(error.name).toBe("SandboxPathError");
  });
});
