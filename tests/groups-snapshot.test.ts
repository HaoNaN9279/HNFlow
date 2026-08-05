// 功能组快照有效期校验与级联刷新测试（v0.3.0 T6）：checkSnapshotFresh / refreshSnapshot。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { initGroup } from "../src/groups/init.js";
import { releaseGroup } from "../src/groups/release.js";
import { resolveWorkflowGroups } from "../src/groups/resolve.js";
import { checkSnapshotFresh, refreshSnapshot } from "../src/groups/snapshot.js";
import type { SnapshotWorkflow } from "../src/groups/snapshot.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-snapshot-test";

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
});

async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function makeWorkflow(nodes: readonly Node[]): Workflow {
  return { id: "wf-1", name: "测试工作流", version: "1.0.0", nodes, edges: [] };
}

function declareNode(id: string, name: string, capabilityGroups: unknown): Node {
  return { id, type: "agent", name, params: { capabilityGroups }, inputs: [], outputs: [] };
}

/** 解析并生成带快照字段的工作流（模拟 T5 保存时固化的快照）。 */
async function makeSnapshotWorkflow(rootDir: string, workflow: Workflow): Promise<SnapshotWorkflow> {
  const result = await resolveWorkflowGroups(rootDir, workflow);
  return { ...workflow, resolvedGroups: result.resolvedGroups, resolvedAt: result.resolvedAt };
}

/** 把功能组 group.json mtime 设为 60 秒后（Windows mtime 精度：显式差 60s 以上避免同秒）。 */
async function touchGroupJsonFuture(rootDir: string, namespace: string): Promise<void> {
  const future = new Date(Date.now() + 60_000);
  await utimes(join(rootDir, ...namespace.split("/"), "group.json"), future, future);
}

describe("checkSnapshotFresh 新鲜度", () => {
  test("resolve 后立即校验 → 新鲜", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const wf = await makeSnapshotWorkflow(TEMP_BASE, makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }]),
    ]));
    const status = await checkSnapshotFresh(TEMP_BASE, wf);
    expect(status.fresh).toBe(true);
    expect(status.expiredGroups).toEqual([]);
  });

  test("无快照字段工作流 → 新鲜（无需校验）", async () => {
    const status = await checkSnapshotFresh(TEMP_BASE, makeWorkflow([]));
    expect(status.fresh).toBe(true);
  });

  test("resolvedAt 非 ISO → 保守过期", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const wf: SnapshotWorkflow = {
      ...makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]),
      resolvedGroups: [`${a.guid}@0.1.0`],
      resolvedAt: "not-a-date",
    };
    const status = await checkSnapshotFresh(TEMP_BASE, wf);
    expect(status.fresh).toBe(false);
  });

  test("resolvedGroups 内 guid 缺失 → 过期并列出", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const wf = await makeSnapshotWorkflow(TEMP_BASE, makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }]),
    ]));
    await rm(join(TEMP_BASE, "demo"), { recursive: true, force: true });
    const status = await checkSnapshotFresh(TEMP_BASE, wf);
    expect(status.fresh).toBe(false);
    expect(status.expiredGroups).toHaveLength(1);
    expect(status.expiredGroups[0]?.guid).toBe(a.guid);
  });
});

describe("过期检测", () => {
  test("group.json mtime 设为将来 → 过期并列出该 guid", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const wf = await makeSnapshotWorkflow(TEMP_BASE, makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }]),
    ]));
    await touchGroupJsonFuture(TEMP_BASE, "demo/a");
    const status = await checkSnapshotFresh(TEMP_BASE, wf);
    expect(status.fresh).toBe(false);
    expect(status.expiredGroups.map((g) => g.guid)).toEqual([a.guid]);
    expect(status.expiredGroups[0]?.namespace).toBe("demo/a");
    expect(status.expiredGroups[0]?.mtimeMs).toBeGreaterThan(Date.parse(wf.resolvedAt ?? ""));
  });

  test("release 新版本改 group.json → 原快照过期", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const wf = await makeSnapshotWorkflow(TEMP_BASE, makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }]),
    ]));
    await releaseGroup(TEMP_BASE, "demo/a", "0.2.0");
    const status = await checkSnapshotFresh(TEMP_BASE, wf);
    expect(status.fresh).toBe(false);
    expect(status.expiredGroups.map((g) => g.guid)).toEqual([a.guid]);
  });

  test("多依赖组：仅过期者被列出", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    const wf = await makeSnapshotWorkflow(TEMP_BASE, makeWorkflow([
      declareNode("ai-1", "AI 节点", [
        { guid: a.guid, version: "0.1.0" },
        { guid: b.guid, version: "0.1.0" },
      ]),
    ]));
    await touchGroupJsonFuture(TEMP_BASE, "demo/b");
    const status = await checkSnapshotFresh(TEMP_BASE, wf);
    expect(status.fresh).toBe(false);
    expect(status.expiredGroups.map((g) => g.guid)).toEqual([b.guid]);
  });
});

describe("refreshSnapshot 级联刷新", () => {
  test("过期后刷新：新对象新 resolvedAt，原对象不变，刷新后可校验新鲜", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const wf = await makeSnapshotWorkflow(TEMP_BASE, makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }]),
    ]));
    await releaseGroup(TEMP_BASE, "demo/a", "0.2.0"); // 新版本使 group.json mtime 更新 → 原快照过期
    expect((await checkSnapshotFresh(TEMP_BASE, wf)).fresh).toBe(false);

    const oldResolvedAt = wf.resolvedAt;
    const refreshed = await refreshSnapshot(TEMP_BASE, wf);
    expect(refreshed).not.toBe(wf);
    expect(Date.parse(refreshed.resolvedAt ?? "")).toBeGreaterThan(Date.parse(oldResolvedAt ?? ""));
    expect(refreshed.resolvedGroups).toEqual(wf.resolvedGroups);
    expect(wf.resolvedAt).toBe(oldResolvedAt);
    expect((await checkSnapshotFresh(TEMP_BASE, refreshed)).fresh).toBe(true);
  });
});
