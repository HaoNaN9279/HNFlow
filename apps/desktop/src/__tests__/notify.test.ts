// T3 系统通知服务纯函数单测（无 electron，bun test 直跑）。
// 运行方式：仓库根 `bun test apps/desktop/src/__tests__/notify.test.ts`。
import { describe, expect, it } from "bun:test";
import { buildRunNotification } from "../notify.js";

describe("buildRunNotification", () => {
  it("成功：标题「工作流运行完成」，正文含 runId", () => {
    const n = buildRunNotification({ ok: true, runId: "run-abc" });
    expect(n.title).toBe("工作流运行完成");
    expect(n.body).toContain("run-abc");
  });

  it("成功且带 message：忽略 message，正文只含 runId", () => {
    const n = buildRunNotification({ ok: true, runId: "run-abc", message: "不应出现" });
    expect(n.title).toBe("工作流运行完成");
    expect(n.body).toBe("运行 ID：run-abc");
    expect(n.body).not.toContain("不应出现");
  });

  it("失败带 message：标题「工作流运行失败」，正文含 message 与 runId", () => {
    const n = buildRunNotification({ ok: false, runId: "run-xyz", message: "节点「执行命令」执行失败" });
    expect(n.title).toBe("工作流运行失败");
    expect(n.body).toContain("节点「执行命令」执行失败");
    expect(n.body).toContain("run-xyz");
  });

  it("失败无 message：标题「工作流运行失败」，正文兜底文案 + runId", () => {
    const n = buildRunNotification({ ok: false, runId: "run-xyz" });
    expect(n.title).toBe("工作流运行失败");
    expect(n.body).toContain("run-xyz");
    expect(n.body).toContain("工作流运行失败");
  });
});
