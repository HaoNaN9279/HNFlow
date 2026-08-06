// v0.4.2 AI 对话纯逻辑单测（无 electron，bun test 直跑）。
// 运行方式：apps/desktop 下 `bun test src/ipc/__tests__/agent.test.ts`。
import { describe, expect, it } from "bun:test";
import type { Workflow } from "../../../../../src/model/types.js";
import { chatWithAgent } from "../agent.js";

describe("chatWithAgent", () => {
  it("fake provider 固定脚本 → ok:true，生成合法工作流（含 start/end、command 带 reviewRequired）", async () => {
    const result = await chatWithAgent({
      messages: [{ role: "user", content: "创建一个发布流程，包含资源导入、打包、测试" }],
      model: { provider: "fake" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.workflow).toBeDefined();
    const workflow = result.workflow as Workflow;
    expect(workflow.name).toBe("发布流程");
    const types = workflow.nodes.map((node) => node.type);
    expect(types).toContain("start");
    expect(types).toContain("end");
    const commandNode = workflow.nodes.find((node) => node.type === "command");
    expect(commandNode?.params["reviewRequired"]).toBe(true);
    expect(commandNode?.params["generatedBy"]).toBe("ai");
  });

  it("非法模型 provider → ok:false 中文错误", async () => {
    const result = await chatWithAgent({
      messages: [{ role: "user", content: "你好" }],
      model: { provider: "unknown-provider" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("不支持的模型提供商");
    expect(result.message).toContain("unknown-provider");
  });
});
