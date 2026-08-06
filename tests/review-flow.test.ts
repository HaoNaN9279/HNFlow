// 审核流集成测试（v0.4.2 验收 2）：Engine 桥接 + command 节点放行。
// - Engine 级：onReviewRequired approve → 命令执行成功；reject → 节点失败；
// - 黑名单始终拦截：reviewRequired=true + approve + 黑名单命令 → 仍失败（与批准无关）。
import { describe, expect, test } from "bun:test";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Workflow } from "../src/model/types.js";

/** 便捷构造 command 工作流：单 command 节点（无入边，根节点直接执行）。 */
function makeCommandWorkflow(command: string, args: readonly string[], reviewRequired: boolean): Workflow {
  return {
    id: "review-wf",
    name: "审核流",
    version: "0.1.0",
    nodes: [
      {
        id: "cmd",
        type: "command",
        name: "执行命令",
        params: { command, ...(args.length === 0 ? {} : { args }), reviewRequired },
        inputs: [],
        outputs: [
          { id: "stdout", name: "stdout", type: "string", direction: "out" },
          { id: "stderr", name: "stderr", type: "string", direction: "out" },
          { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
        ],
      },
    ],
    edges: [],
  };
}

describe("v0.4.2 审核流（Engine 桥接 + command 放行）", () => {
  test("reviewRequired + approve → 命令执行成功（stdout 有输出）", async () => {
    const engine = new ExecutionEngine(makeCommandWorkflow("node", ["-e", "console.log('review-ok')"], true), {
      onReviewRequired: async () => "approve",
    });
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["cmd"]?.["stdout"]).toContain("review-ok");
    // approve 后节点被标记：内部已批准集合生效（重跑不再次询问）——status success 即证明未二次触发审核。
    expect(result.nodeStates["cmd"]).toBe("Success");
  });

  test("reviewRequired + reject → 节点失败（含审核消息）", async () => {
    const engine = new ExecutionEngine(makeCommandWorkflow("node", ["-e", "console.log('x')"], true), {
      onReviewRequired: async () => "reject",
    });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("命令待人工审核");
    expect(result.nodeStates["cmd"]).toBe("Failed");
  });

  test("reviewRequired 未注入回调 → 缺省 reject → 节点失败", async () => {
    const engine = new ExecutionEngine(makeCommandWorkflow("node", ["-e", "console.log('x')"], true));
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("命令待人工审核");
  });

  test("黑名单始终拦截：reviewRequired + approve + rm -rf / → 仍失败", async () => {
    const engine = new ExecutionEngine(makeCommandWorkflow("rm -rf /", [], true), {
      onReviewRequired: async () => "approve",
    });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("命令被黑名单拦截");
    expect(result.nodeStates["cmd"]).toBe("Failed");
  });

  test("reviewRequired=false → 不经审核直接执行成功", async () => {
    const engine = new ExecutionEngine(makeCommandWorkflow("node", ["-e", "console.log('plain-ok')"], false), {
      onReviewRequired: async () => {
        throw new Error("不应触发审核询问");
      },
    });
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["cmd"]?.["stdout"]).toContain("plain-ok");
  });
});
