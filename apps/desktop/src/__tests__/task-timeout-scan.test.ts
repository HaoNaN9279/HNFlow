// 人工任务超时扫描编排单测（v0.9.3）：stub store + spy notify，验证通知次数与内容（不碰 electron）。
// 运行方式：仓库根 `bun test apps/desktop/src/__tests__/task-timeout-scan.test.ts`。
import { describe, expect, it } from "bun:test";
import type { HumanTaskStoreLike } from "../../../../src/db/stores/types.js";
import type { HumanTask } from "../../../../src/human/types.js";
import type { NotifyFn } from "../task-timeout-scan.js";
import { scanAndNotify } from "../task-timeout-scan.js";

function makeTask(overrides: Partial<HumanTask> = {}): HumanTask {
  return {
    id: "task-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    nodeName: "审批节点",
    title: "审批预算",
    status: "pending",
    fallback: "manual",
    createdAt: 1_000_000,
    ...overrides,
  };
}

/** stub store：只实现 scanAndNotify 用到的 listPending。 */
function makeStore(tasks: readonly HumanTask[]): Pick<HumanTaskStoreLike, "listPending"> {
  return { listPending: async () => [...tasks] };
}

/** spy notify：记录调用参数，返回调用次数。 */
function makeSpy(): { notify: NotifyFn; calls: Array<{ title: string; body: string }> } {
  const calls: Array<{ title: string; body: string }> = [];
  return {
    calls,
    notify: (title, body) => {
      calls.push({ title, body });
    },
  };
}

describe("scanAndNotify", () => {
  it("有超时任务：按超时条数调用通知，每条带标题与中文文案", async () => {
    const store = makeStore([
      makeTask({ id: "a", createdAt: 1_000_000 }),
      makeTask({ id: "b", createdAt: 1_000_000 }),
      makeTask({ id: "c", createdAt: 1_900_000 }), // 未超时
    ]);
    const spy = makeSpy();
    const count = await scanAndNotify(store, 2_000_000, 100_000, spy.notify);
    expect(count).toBe(2);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.title).toBe("人工任务超时提醒");
    expect(spy.calls[0]?.body).toContain("审批预算");
    expect(spy.calls[0]?.body).toContain("审批节点");
  });

  it("无超时任务：不调用通知", async () => {
    const store = makeStore([makeTask({ id: "a", createdAt: 1_900_000 })]);
    const spy = makeSpy();
    const count = await scanAndNotify(store, 2_000_000, 100_000, spy.notify);
    expect(count).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });

  it("空 store：返回 0，不调用通知", async () => {
    const spy = makeSpy();
    const count = await scanAndNotify(makeStore([]), 2_000_000, 100_000, spy.notify);
    expect(count).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });

  it("listPending 抛错：异常向上传播（容错由调用方负责）", async () => {
    const store: Pick<HumanTaskStoreLike, "listPending"> = {
      listPending: async () => {
        throw new Error("store broken");
      },
    };
    const spy = makeSpy();
    await expect(scanAndNotify(store, 2_000_000, 100_000, spy.notify)).rejects.toThrow("store broken");
    expect(spy.calls).toHaveLength(0);
  });
});
