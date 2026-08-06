// v0.4.2 内存单次运行纯逻辑单测（无 electron，bun test 直跑）。
// 运行方式：apps/desktop 下 `bun test src/ipc/__tests__/run.test.ts`。
import { describe, expect, it } from "bun:test";
import { runWorkflowOnce } from "../run.js";
import type { RunWorkflowPayload } from "../../shared/ipc.js";
import type { Workflow } from "../../../../../src/model/types.js";

/** 便捷构造合法 workflow 节点（port 形状与 workflowSchema 对齐）。 */
function node(
  id: string,
  type: string,
  name: string,
  params: Readonly<Record<string, unknown>>,
  ports: { readonly inputs: Workflow["nodes"][number]["inputs"]; readonly outputs: Workflow["nodes"][number]["outputs"] },
) {
  return { id, type, name, params, ...ports };
}

const startNode = node("start", "start", "开始", {}, {
  inputs: [],
  outputs: [{ id: "data", name: "data", type: "any", direction: "out" }],
});

const endNode = node("end", "end", "结束", {}, {
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [],
});

const logNode = node("log", "log", "日志", { message: "hello", level: "info" }, { inputs: [], outputs: [] });

const commandNode = node("cmd", "command", "执行命令", {}, {
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
});

/** 待审核 command 节点：reviewRequired=true，命令为安全 node 脚本（v0.4.2 验收 2 审核流）。 */
const reviewCommandNode = node("cmd-review", "command", "待审核命令", {
  command: "node",
  args: ["-e", "console.log('review-ok')"],
  reviewRequired: true,
}, {
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
});

describe("runWorkflowOnce", () => {
  it("简单 workflow（start→log→end）运行成功 ok:true 且带 runId", async () => {
    const result = await runWorkflowOnce({
      workflow: { id: "run-ok-wf", name: "运行成功", version: "0.1.0", nodes: [startNode, logNode, endNode], edges: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId.length).toBeGreaterThan(0);
    }
  });

  it("失败 workflow（command 参数非法）→ ok:false 带中文消息与 nodeId/nodePath", async () => {
    const result = await runWorkflowOnce({
      workflow: { id: "run-fail-wf", name: "运行失败", version: "0.1.0", nodes: [startNode, commandNode], edges: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("执行命令");
      expect(result.message).toContain("invalid command params");
      expect(result.nodeId).toBe("cmd");
      expect(result.nodePath).toContain("顶层工作流");
    }
  });

  it("非法 workflow（节点缺 name）→ 中文校验错误消息", async () => {
    const result = await runWorkflowOnce({
      workflow: {
        id: "run-invalid-wf",
        name: "非法",
        version: "0.1.0",
        nodes: [{ id: "start", type: "start", params: {}, inputs: [], outputs: [] }], // 缺 name
        edges: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/^工作流数据不合法/);
    }
  });
});

describe("runWorkflowOnce 审核桥接（v0.4.2 验收 2）", () => {
  const reviewWorkflow: RunWorkflowPayload = {
    workflow: {
      id: "run-review-wf",
      name: "审核流",
      version: "0.1.0",
      nodes: [reviewCommandNode],
      edges: [],
    },
  };

  it("onReviewRequest 返回 approve → 命令执行成功 ok:true", async () => {
    const result = await runWorkflowOnce(reviewWorkflow, {
      onReviewRequest: async (request) => {
        expect(request.nodeId).toBe("cmd-review");
        expect(request.description).toContain("node");
        expect(request.requestId.length).toBeGreaterThan(0);
        return "approve";
      },
    });
    expect(result.ok).toBe(true);
  });

  it("onReviewRequest 返回 reject → ok:false 带审核中文消息", async () => {
    const result = await runWorkflowOnce(reviewWorkflow, {
      onReviewRequest: async () => "reject",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("命令待人工审核");
      expect(result.nodeId).toBe("cmd-review");
    }
  });

  it("不传 onReviewRequest → 缺省拒绝 → ok:false", async () => {
    const result = await runWorkflowOnce(reviewWorkflow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("命令待人工审核");
    }
  });
});
