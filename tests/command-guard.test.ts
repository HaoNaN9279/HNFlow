// 命令安全护栏测试（v0.4.2）：黑名单拦截 + AI 生成命令人工审核。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { commandNode } from "../src/nodes/command.js";
import {
  BlacklistedCommandError,
  ReviewRequiredError,
  checkCommandSafety,
} from "../src/security/command-guard.js";

function makeNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type: "command", name: id, params, inputs: [], outputs: [] };
}

// 最小 mock 上下文：command 节点仅消费 ctx.node.params。
function createMockContext(node: Node): NodeExecutionContext {
  return {
    node,
    workflowId: "test-wf",
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

describe("v0.4.2 命令安全护栏 checkCommandSafety", () => {
  test("黑名单命中 rm -rf / → 抛 BlacklistedCommandError", () => {
    expect(() => checkCommandSafety("rm -rf /", false)).toThrow(
      BlacklistedCommandError,
    );
  });

  test("黑名单命中 rm -rf C:\\ → 抛 BlacklistedCommandError", () => {
    expect(() => checkCommandSafety("rm -rf C:\\", false)).toThrow(
      BlacklistedCommandError,
    );
  });

  test("黑名单命中 del /s /q C:\\ → 抛 BlacklistedCommandError", () => {
    expect(() => checkCommandSafety("del /s /q C:\\", false)).toThrow(
      BlacklistedCommandError,
    );
  });

  test("黑名单命中 format c: → 抛 BlacklistedCommandError", () => {
    expect(() => checkCommandSafety("format c:", false)).toThrow(
      BlacklistedCommandError,
    );
  });

  test("黑名单命中 shutdown /s → 抛 BlacklistedCommandError", () => {
    expect(() => checkCommandSafety("shutdown /s", false)).toThrow(
      BlacklistedCommandError,
    );
  });

  test("黑名单错误消息含命令原文与中文提示", () => {
    try {
      checkCommandSafety("rm -rf /", false);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BlacklistedCommandError);
      if (error instanceof BlacklistedCommandError) {
        expect(error.command).toBe("rm -rf /");
        expect(error.message).toContain("命令被黑名单拦截：rm -rf /");
        expect(error.message).toContain("高危操作");
      }
    }
  });

  test("安全命令 echo hello → 不抛", () => {
    expect(() => checkCommandSafety("echo hello", false)).not.toThrow();
  });

  test("安全命令 git status → 不抛", () => {
    expect(() => checkCommandSafety("git status", false)).not.toThrow();
  });

  test("reviewRequired=true → 抛 ReviewRequiredError", () => {
    expect(() => checkCommandSafety("echo hello", true)).toThrow(
      ReviewRequiredError,
    );
  });

  test("reviewRequired=false → 不抛", () => {
    expect(() => checkCommandSafety("echo hello", false)).not.toThrow();
  });

  test("reviewRequired=undefined → 不抛", () => {
    expect(() => checkCommandSafety("echo hello", undefined)).not.toThrow();
  });

  test("黑名单优先：rm -rf / 且 reviewRequired=true → 抛 BlacklistedCommandError", () => {
    expect(() => checkCommandSafety("rm -rf /", true)).toThrow(
      BlacklistedCommandError,
    );
  });

  test("ReviewRequiredError 携带 description 与中文消息", () => {
    try {
      checkCommandSafety("echo hello", true);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewRequiredError);
      if (error instanceof ReviewRequiredError) {
        expect(error.description).toBe("echo hello");
        expect(error.message).toContain("命令待人工审核：echo hello");
      }
    }
  });
});

describe("v0.4.2 command 节点安全护栏", () => {
  test("params.reviewRequired=true → execute 抛 ReviewRequiredError（携带 nodeId）", async () => {
    const node = makeNode("cmd-guard", { command: "echo hello", reviewRequired: true });
    await expect(commandNode.execute(createMockContext(node))).rejects.toThrow(
      ReviewRequiredError,
    );
    await expect(commandNode.execute(createMockContext(node))).rejects.toMatchObject(
      { nodeId: "cmd-guard" },
    );
  });

  test("黑名单命令 → execute 抛 BlacklistedCommandError", async () => {
    const node = makeNode("cmd-guard", { command: "rm -rf /" });
    await expect(commandNode.execute(createMockContext(node))).rejects.toThrow(
      BlacklistedCommandError,
    );
  });

  test("不带 reviewRequired → 行为不变：正常执行 node -e", async () => {
    const node = makeNode("cmd", { command: "node", args: ["-e", "console.log('hello')"] });
    const result = await commandNode.execute(createMockContext(node));
    expect(result["stdout"]).toContain("hello");
    expect(result["exitCode"]).toBe(0);
  });

  test("generatedBy=manual 且无审核 → 行为不变", async () => {
    const node = makeNode("cmd", {
      command: "node",
      args: ["-e", "console.log('ok')"],
      generatedBy: "manual",
    });
    const result = await commandNode.execute(createMockContext(node));
    expect(result["stdout"]).toContain("ok");
    expect(result["exitCode"]).toBe(0);
  });
});
