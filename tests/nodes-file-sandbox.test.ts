// file 节点沙箱（v0.9.4）：配置 sandboxRootDir 时逃逸路径拒绝（SandboxPathError）、沙箱内放行（写读真实文件）、未配置原行为。
import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { fileNode } from "../src/nodes/file.js";
import { SandboxPathError } from "../src/security/path-sandbox.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type: "file", name: id, params, inputs: [], outputs: [] };
}

function createMockContext(node: Node, sandboxRootDir?: string): NodeExecutionContext {
  return {
    node,
    workflowId: "test-wf",
    ...(sandboxRootDir === undefined ? {} : { sandboxRootDir }),
    get() {
      return undefined;
    },
    set() {},
    getByPath() {
      return undefined;
    },
    setByPath() {},
    getAll() {
      return {};
    },
    suspend(): never {
      throw new Error("suspend not implemented in test mock");
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

const tmpBases: string[] = [];

async function makeSandbox(prefix: string): Promise<{ readonly base: string; readonly sandbox: string }> {
  const base = await mkdtemp(join(TEMP_BASE, prefix));
  tmpBases.push(base);
  const sandbox = join(base, "sandbox");
  await mkdir(sandbox, { recursive: true });
  return { base, sandbox };
}

afterAll(async () => {
  await Promise.all(tmpBases.map((path) => rm(path, { recursive: true, force: true })));
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("file 节点沙箱", () => {
  test("沙箱启用 + 逃逸路径（../）→ 抛 SandboxPathError 且沙箱外未写文件", async () => {
    const { base, sandbox } = await makeSandbox("hnflow-file-sb-esc-");
    const escapedPath = join(base, "escaped.txt");
    const node = makeNode("w", { operation: "write", path: join("..", "escaped.txt"), content: "evil" });
    await expect(fileNode.execute(createMockContext(node, sandbox))).rejects.toThrow(SandboxPathError);
    expect(await exists(escapedPath)).toBe(false);
  });

  test("沙箱启用 + 绝对路径逃逸 → 抛 SandboxPathError", async () => {
    const { base, sandbox } = await makeSandbox("hnflow-file-sb-abs-");
    const node = makeNode("w", { operation: "write", path: join(base, "outside.txt"), content: "evil" });
    await expect(fileNode.execute(createMockContext(node, sandbox))).rejects.toThrow(SandboxPathError);
  });

  test("沙箱启用 + 沙箱内写读真实文件 → 放行且写落在沙箱内", async () => {
    const { base, sandbox } = await makeSandbox("hnflow-file-sb-ok-");
    const relativePath = join("in", "file.txt");
    const writeNode = makeNode("w", { operation: "write", path: relativePath, content: "hello sandbox" });
    const writeResult = await fileNode.execute(createMockContext(writeNode, sandbox));
    expect(writeResult["bytesWritten"]).toBe(13);
    const realPath = resolve(sandbox, relativePath);
    expect(await readFile(realPath, "utf8")).toBe("hello sandbox");
    expect(await exists(join(base, "sandbox-in", "file.txt"))).toBe(false);

    const readNode = makeNode("r", { operation: "read", path: relativePath });
    const readResult = await fileNode.execute(createMockContext(readNode, sandbox));
    expect(readResult["content"]).toBe("hello sandbox");
  });

  test("未配置沙箱 → 原行为（沙箱外路径写读正常）", async () => {
    const { base } = await makeSandbox("hnflow-file-sb-off-");
    const filePath = join(base, "plain.txt");
    const writeNode = makeNode("w", { operation: "write", path: filePath, content: "plain" });
    const writeResult = await fileNode.execute(createMockContext(writeNode));
    expect(writeResult["bytesWritten"]).toBe(5);
    const readNode = makeNode("r", { operation: "read", path: filePath });
    const readResult = await fileNode.execute(createMockContext(readNode));
    expect(readResult["content"]).toBe("plain");
  });
});
