// command 节点沙箱（v0.9.4）：配置 sandboxRootDir 时 cwd 缺省强制沙箱根、显式 cwd 逃逸拒绝（SandboxPathError）、未配置原行为。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { commandNode } from "../src/nodes/command.js";
import { SandboxPathError } from "../src/security/path-sandbox.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type: "command", name: id, params, inputs: [], outputs: [] };
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

describe("command 节点沙箱", () => {
  test("沙箱启用 + cwd 缺省 → 子进程工作目录强制沙箱根", async () => {
    const { sandbox } = await makeSandbox("hnflow-cmd-sb-cwd-");
    const node = makeNode("cwd", {
      command: "node",
      args: ["-e", "console.log(process.cwd())"],
    });
    const result = await commandNode.execute(createMockContext(node, sandbox));
    const stdout = String(result["stdout"]).trim();
    expect(stdout.toLowerCase()).toBe(resolve(sandbox).toLowerCase());
  });

  test("沙箱启用 + 显式 cwd 逃逸 → 抛 SandboxPathError", async () => {
    const { base, sandbox } = await makeSandbox("hnflow-cmd-sb-esc-");
    const node = makeNode("esc", {
      command: "node",
      args: ["-e", "console.log('x')"],
      cwd: join(base, "outside"),
    });
    await expect(commandNode.execute(createMockContext(node, sandbox))).rejects.toThrow(SandboxPathError);
  });

  test("沙箱启用 + 显式 cwd 沙箱内 → 放行且工作目录为解析后路径", async () => {
    const { sandbox } = await makeSandbox("hnflow-cmd-sb-in-");
    await mkdir(join(sandbox, "work"), { recursive: true });
    const node = makeNode("in", {
      command: "node",
      args: ["-e", "console.log(process.cwd())"],
      cwd: "work",
    });
    const result = await commandNode.execute(createMockContext(node, sandbox));
    const stdout = String(result["stdout"]).trim();
    expect(stdout.toLowerCase()).toBe(resolve(sandbox, "work").toLowerCase());
  });

  test("未配置沙箱 → 原行为（cwd 缺省 = 引擎当前目录）", async () => {
    const node = makeNode("plain", {
      command: "node",
      args: ["-e", "console.log(process.cwd())"],
    });
    const result = await commandNode.execute(createMockContext(node));
    const stdout = String(result["stdout"]).trim();
    expect(stdout.toLowerCase()).toBe(resolve(process.cwd()).toLowerCase());
  });
});
