// 子图审核透传集成测试（v0.4.3 验收 4）：子工作流内 command reviewRequired 节点审批。
// - 子图内 approve：父引擎透传 onReviewRequired + 共享已批准集合 → 命令执行成功；
// - 子图内 reject：子引擎拒绝 → 子图失败冒泡；
// - 共享语义：子图内 approve 后父引擎同一节点再次执行不重复询问（onReviewRequired 仅调一次）。
import { describe, expect, test } from "bun:test";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Workflow } from "../src/model/types.js";

/** 构造子工作流：单 command 节点（reviewRequired），无入边根节点直接执行。 */
function makeSubWorkflow(command: string, args: readonly string[], reviewRequired: boolean): Workflow {
  return {
    id: "sub",
    name: "子审核流",
    version: "0.1.0",
    nodes: [
      {
        id: "sub-cmd",
        type: "command",
        name: "子图命令",
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

/** 构造父工作流：单 subworkflow 节点（内嵌子工作流）。 */
function makeParentWorkflow(subworkflow: Workflow): Workflow {
  return {
    id: "parent",
    name: "父工作流",
    version: "0.1.0",
    nodes: [
      {
        id: "top",
        type: "subworkflow",
        name: "顶层子工作流",
        params: { subworkflow },
        inputs: [],
        outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
      },
    ],
    edges: [],
  };
}

describe("v0.4.3 子图审核透传", () => {
  test("子图内 approve → 命令执行成功（子引擎共享父集合）", async () => {
    const engine = new ExecutionEngine(makeParentWorkflow(makeSubWorkflow("node", ["-e", "console.log('sub-review-ok')"], true)), {
      onReviewRequired: async () => "approve",
    });
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["top"]).toBe("Success");
  });

  test("子图内 reject → 子图失败冒泡（SubworkflowFailedError）", async () => {
    const engine = new ExecutionEngine(makeParentWorkflow(makeSubWorkflow("node", ["-e", "console.log('x')"], true)), {
      onReviewRequired: async () => "reject",
    });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("子工作流执行失败");
    expect(result.error).toContain("命令待人工审核");
    expect(result.nodeStates["top"]).toBe("Failed");
  });

  test("子图内未注入回调 → 缺省 reject → 子图失败", async () => {
    const engine = new ExecutionEngine(makeParentWorkflow(makeSubWorkflow("node", ["-e", "console.log('x')"], true)));
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("子工作流执行失败");
    expect(result.error).toContain("命令待人工审核");
  });

  test("共享语义：子图内 approve 后父引擎同一节点再次执行不重复询问", async () => {
    let calls = 0;
    const engine = new ExecutionEngine(makeParentWorkflow(makeSubWorkflow("node", ["-e", "console.log('again')"], true)), {
      onReviewRequired: async () => {
        calls++;
        return "approve";
      },
    });
    const first = await engine.run();
    expect(first.status).toBe("success");
    expect(calls).toBe(1);
    // 父引擎同一节点再次执行（run 重置节点状态，保留共享已批准集合）：子图命令已批准 → 不重复询问。
    const second = await engine.run();
    expect(second.status).toBe("success");
    expect(calls).toBe(1);
  });
});
