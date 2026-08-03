// 命令行节点集成测试（AC1）：Bun.spawn 执行系统命令并捕获输出。
import { describe, expect, test } from "bun:test";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import {
  commandNode,
  InvalidCommandParamsError,
  NonZeroExitError,
  TimeoutError,
} from "../src/nodes/command.js";

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

describe("AC1 命令行节点", () => {
  test("执行 node -e console.log('hi') → stdout 含 hi / exitCode 0", async () => {
    const node = makeNode("cmd", { command: "node", args: ["-e", "console.log('hi')"] });
    const result = await commandNode.execute(createMockContext(node));
    expect(result["stdout"]).toContain("hi");
    expect(result["exitCode"]).toBe(0);
  });

  test("非零退出码 failOnNonZero: true → 抛 NonZeroExitError", async () => {
    const node = makeNode("cmd", {
      command: "node",
      args: ["-e", "process.exit(3)"],
      failOnNonZero: true,
    });
    await expect(commandNode.execute(createMockContext(node))).rejects.toThrow(NonZeroExitError);
  });

  test("非零退出码 failOnNonZero 默认 false → 正常返回 exitCode 非 0", async () => {
    const node = makeNode("cmd", { command: "node", args: ["-e", "process.exit(3)"] });
    const result = await commandNode.execute(createMockContext(node));
    expect(result["exitCode"]).toBe(3);
    expect(result["stdout"]).toBe("");
  });

  test("缺 command 参数 → 抛 InvalidCommandParamsError", async () => {
    const node = makeNode("cmd", { args: ["-e", "console.log('x')"] });
    await expect(commandNode.execute(createMockContext(node))).rejects.toThrow(
      InvalidCommandParamsError,
    );
  });

  test("超时 timeoutMs 100 → 抛 TimeoutError", async () => {
    const node = makeNode("cmd", {
      command: "node",
      args: ["-e", "setTimeout(()=>{},100000)"],
      timeoutMs: 100,
    });
    await expect(commandNode.execute(createMockContext(node))).rejects.toThrow(TimeoutError);
  });
});
