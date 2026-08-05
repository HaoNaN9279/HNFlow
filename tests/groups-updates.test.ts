// 功能组版本通知测试（v0.3.2 T1）：checkGroupUpdates 对比依赖快照与 currentVersion 输出可升级列表。
// 临时目录用 opencode 专用 temp + 随机后缀，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { initGroup } from "../src/groups/init.js";
import { releaseGroup } from "../src/groups/release.js";
import { checkGroupUpdates, type GroupUpdateEntry } from "../src/groups/updates.js";
import { collectDeclarations } from "../src/groups/resolve.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-tests-${randomUUID()}`);

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试（Windows 惯例）。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows 句柄释放依赖 GC，强制回收以解锁文件
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

function makeWorkflow(resolvedGroups?: readonly string[]): Workflow {
  return {
    id: "wf-1",
    name: "测试工作流",
    version: "1.0.0",
    nodes: [],
    edges: [],
    ...(resolvedGroups !== undefined ? { resolvedGroups } : {}),
  };
}

function declareNode(id: string, name: string, capabilityGroups: unknown): Node {
  return { id, type: "agent", name, params: { capabilityGroups }, inputs: [], outputs: [] };
}

/** 按 guid 在报告条目中查找（不依赖排序）。 */
function findByGuid(entries: readonly GroupUpdateEntry[], guid: string): GroupUpdateEntry | undefined {
  return entries.find((entry) => entry.guid === guid);
}

describe("checkGroupUpdates", () => {
  test("无 resolvedGroups（undefined / 空数组）→ 空报告", async () => {
    await initGroup(TEMP_BASE, "demo/a");
    expect(await checkGroupUpdates(TEMP_BASE, makeWorkflow())).toEqual({ entries: [], ignoredCount: 0 });
    expect(await checkGroupUpdates(TEMP_BASE, makeWorkflow([]))).toEqual({ entries: [], ignoredCount: 0 });
  });

  test("单组 patch 升级：locked 1.0.0 latest 1.0.1 → diff=patch 入 entries", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([`${a.guid}@1.0.0`]);
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.1");

    const report = await checkGroupUpdates(TEMP_BASE, workflow);
    expect(report.ignoredCount).toBe(0);
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0];
    expect(entry?.guid).toBe(a.guid);
    expect(entry?.namespace).toBe("demo/a");
    expect(entry?.lockedVersion).toBe("1.0.0");
    expect(entry?.latestVersion).toBe("1.0.1");
    expect(entry?.diff).toBe("patch");
  });

  test("minor / major 分类正确", async () => {
    const minorGroup = await initGroup(TEMP_BASE, "demo/minor");
    await releaseGroup(TEMP_BASE, "demo/minor", "1.0.0");
    const majorGroup = await initGroup(TEMP_BASE, "demo/major");
    await releaseGroup(TEMP_BASE, "demo/major", "1.0.0");
    const workflow = makeWorkflow([`${minorGroup.guid}@1.0.0`, `${majorGroup.guid}@1.0.0`]);
    await releaseGroup(TEMP_BASE, "demo/minor", "1.1.0"); // minor 升级
    await releaseGroup(TEMP_BASE, "demo/major", "2.0.0"); // major 升级

    const report = await checkGroupUpdates(TEMP_BASE, workflow);
    expect(report.entries).toHaveLength(2);
    expect(findByGuid(report.entries, minorGroup.guid)?.diff).toBe("minor");
    expect(findByGuid(report.entries, majorGroup.guid)?.diff).toBe("major");
  });

  test("已是最新（locked=latest）不进入 entries", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const workflow = makeWorkflow([`${a.guid}@0.1.0`]);

    const report = await checkGroupUpdates(TEMP_BASE, workflow);
    expect(report.entries).toEqual([]);
    expect(report.ignoredCount).toBe(0);
  });

  test("ignores 精确匹配锁定版本跳过并计入 ignoredCount；版本不匹配不误判", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([`${a.guid}@1.0.0`]);
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.1");

    // 精确匹配 "guid@lockedVersion"：跳过并计入 ignoredCount
    const ignored = await checkGroupUpdates(TEMP_BASE, workflow, { ignores: [`${a.guid}@1.0.0`] });
    expect(ignored.entries).toEqual([]);
    expect(ignored.ignoredCount).toBe(1);

    // 版本不匹配锁定版本（写成最新版本）：不忽略，仍进入 entries
    const notIgnored = await checkGroupUpdates(TEMP_BASE, workflow, { ignores: [`${a.guid}@1.0.1`] });
    expect(notIgnored.entries).toHaveLength(1);
    expect(notIgnored.entries[0]?.diff).toBe("patch");
    expect(notIgnored.ignoredCount).toBe(0);
  });

  test("快照引用不存在组：跳过不抛错", async () => {
    const workflow = makeWorkflow(["no-such-guid@1.0.0"]);
    const report = await checkGroupUpdates(TEMP_BASE, workflow);
    expect(report.entries).toEqual([]);
    expect(report.ignoredCount).toBe(0);
  });
});

describe("collectDeclarations 导出（T2 升级遍历复用）", () => {
  test("已导出：收集节点声明返回 guid → 声明版本与路径", () => {
    const workflow: Workflow = {
      id: "wf-1",
      name: "测试工作流",
      version: "1.0.0",
      nodes: [declareNode("ai-1", "AI 节点", [{ guid: "g-fixed", version: "1.2.3" }])],
      edges: [],
    };
    const declarations = collectDeclarations(workflow);
    expect(declarations.get("g-fixed")?.version).toBe("1.2.3");
    expect(declarations.get("g-fixed")?.path).toBe("ai-1 (AI 节点)");
  });
});
