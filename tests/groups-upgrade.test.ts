// 功能组版本升级测试（v0.3.2 T2）：upgradeWorkflow 按门槛升级声明版本并刷新依赖快照。
// 临时目录用 opencode 专用 temp + 随机后缀，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { initGroup } from "../src/groups/init.js";
import { releaseGroup } from "../src/groups/release.js";
import { upgradeWorkflow } from "../src/groups/upgrade.js";
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

function makeWorkflow(nodes: readonly Node[], resolvedGroups: readonly string[]): Workflow {
  return {
    id: "wf-1",
    name: "测试工作流",
    version: "1.0.0",
    nodes,
    edges: [],
    resolvedGroups,
    resolvedAt: "2000-01-01T00:00:00.000Z",
  };
}

function declareNode(id: string, name: string, capabilityGroups: unknown): Node {
  return { id, type: "agent", name, params: { capabilityGroups }, inputs: [], outputs: [] };
}

/** 读取节点声明数组；capabilityGroups 缺失时返回 undefined。 */
function declaredGroups(node: Node | undefined): unknown {
  return node?.params["capabilityGroups"];
}

describe("upgradeWorkflow", () => {
  test("无可升级项（全部最新）→ upgraded 空，返回原 workflow 引用", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a"); // currentVersion 0.1.0
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])], [
      `${a.guid}@0.1.0`,
    ]);

    const result = await upgradeWorkflow(TEMP_BASE, workflow, { autoPatch: true });
    expect(result.upgraded).toEqual([]);
    expect(result.workflow).toBe(workflow);
  });

  test("patch 升级：autoPatch=false 不升；true 升（from→to 正确、diff=patch）", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "1.0.0" }])], [
      `${a.guid}@1.0.0`,
    ]);
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.1");

    // 默认门槛关闭：patch 不自动升级，原引用返回
    const blocked = await upgradeWorkflow(TEMP_BASE, workflow);
    expect(blocked.upgraded).toEqual([]);
    expect(blocked.workflow).toBe(workflow);

    // autoPatch=true：升级声明版本
    const result = await upgradeWorkflow(TEMP_BASE, workflow, { autoPatch: true });
    expect(result.upgraded).toEqual([
      { guid: a.guid, namespace: "demo/a", from: "1.0.0", to: "1.0.1", diff: "patch" },
    ]);
    expect(declaredGroups(result.workflow.nodes[0])).toEqual([{ guid: a.guid, version: "1.0.1" }]);
  });

  test("minor 升级：allowMinor=false 不升；true 升", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "1.0.0" }])], [
      `${a.guid}@1.0.0`,
    ]);
    await releaseGroup(TEMP_BASE, "demo/a", "1.1.0");

    expect((await upgradeWorkflow(TEMP_BASE, workflow)).upgraded).toEqual([]);
    const result = await upgradeWorkflow(TEMP_BASE, workflow, { allowMinor: true });
    expect(result.upgraded).toEqual([
      { guid: a.guid, namespace: "demo/a", from: "1.0.0", to: "1.1.0", diff: "minor" },
    ]);
    expect(declaredGroups(result.workflow.nodes[0])).toEqual([{ guid: a.guid, version: "1.1.0" }]);
  });

  test("major 升级：allowMajor 控制", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "1.0.0" }])], [
      `${a.guid}@1.0.0`,
    ]);
    await releaseGroup(TEMP_BASE, "demo/a", "2.0.0");

    expect((await upgradeWorkflow(TEMP_BASE, workflow, { allowMinor: true })).upgraded).toEqual([]);
    const result = await upgradeWorkflow(TEMP_BASE, workflow, { allowMajor: true });
    expect(result.upgraded).toEqual([
      { guid: a.guid, namespace: "demo/a", from: "1.0.0", to: "2.0.0", diff: "major" },
    ]);
    expect(declaredGroups(result.workflow.nodes[0])).toEqual([{ guid: a.guid, version: "2.0.0" }]);
  });

  test("ignores 过滤：命中锁定版本的项目被忽略不升级", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "1.0.0" }])], [
      `${a.guid}@1.0.0`,
    ]);
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.1");

    const result = await upgradeWorkflow(TEMP_BASE, workflow, { autoPatch: true, ignores: [`${a.guid}@1.0.0`] });
    expect(result.upgraded).toEqual([]);
    expect(result.workflow).toBe(workflow);
  });

  test("嵌套 subworkflow：子图节点声明也被升级", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    await releaseGroup(TEMP_BASE, "demo/b", "1.0.0");
    const inner = makeWorkflow(
      [declareNode("inner-ai", "内部 AI", [{ guid: b.guid, version: "1.0.0" }])],
      [`${b.guid}@1.0.0`],
    );
    const subNode: Node = {
      id: "sub-1",
      type: "subworkflow",
      name: "子工作流",
      params: {},
      inputs: [],
      outputs: [],
      subworkflow: inner,
    };
    const workflow = makeWorkflow(
      [declareNode("outer-ai", "外部 AI", [{ guid: a.guid, version: "1.0.0" }]), subNode],
      [`${a.guid}@1.0.0`, `${b.guid}@1.0.0`],
    );
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.1");
    await releaseGroup(TEMP_BASE, "demo/b", "1.0.1");

    const result = await upgradeWorkflow(TEMP_BASE, workflow, { autoPatch: true });
    expect(result.upgraded).toHaveLength(2);
    expect(declaredGroups(result.workflow.nodes[0])).toEqual([{ guid: a.guid, version: "1.0.1" }]);
    const innerNode = result.workflow.nodes[1]?.subworkflow?.nodes[0];
    expect(declaredGroups(innerNode)).toEqual([{ guid: b.guid, version: "1.0.1" }]);
  });

  test("升级后快照刷新：resolvedGroups 含新版本、resolvedAt 更新", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.0");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "1.0.0" }])], [
      `${a.guid}@1.0.0`,
    ]);
    await releaseGroup(TEMP_BASE, "demo/a", "1.0.1");

    const result = await upgradeWorkflow(TEMP_BASE, workflow, { autoPatch: true });
    expect(result.workflow.resolvedGroups).toContain(`${a.guid}@1.0.1`);
    expect(result.workflow.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.workflow.resolvedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });

  test("多个可升级项混合门槛：只升允许的", async () => {
    const patchGroup = await initGroup(TEMP_BASE, "demo/patch");
    const minorGroup = await initGroup(TEMP_BASE, "demo/minor");
    const majorGroup = await initGroup(TEMP_BASE, "demo/major");
    await releaseGroup(TEMP_BASE, "demo/patch", "1.0.0");
    await releaseGroup(TEMP_BASE, "demo/minor", "1.0.0");
    await releaseGroup(TEMP_BASE, "demo/major", "1.0.0");
    const workflow = makeWorkflow(
      [
        declareNode("ai-1", "AI 节点", [{ guid: patchGroup.guid, version: "1.0.0" }]),
        declareNode("ai-2", "AI 节点", [{ guid: minorGroup.guid, version: "1.0.0" }]),
        declareNode("ai-3", "AI 节点", [{ guid: majorGroup.guid, version: "1.0.0" }]),
      ],
      [`${patchGroup.guid}@1.0.0`, `${minorGroup.guid}@1.0.0`, `${majorGroup.guid}@1.0.0`],
    );
    await releaseGroup(TEMP_BASE, "demo/patch", "1.0.1");
    await releaseGroup(TEMP_BASE, "demo/minor", "1.1.0");
    await releaseGroup(TEMP_BASE, "demo/major", "2.0.0");

    const result = await upgradeWorkflow(TEMP_BASE, workflow, { autoPatch: true, allowMinor: true });
    expect(result.upgraded).toHaveLength(2);
    expect(result.upgraded.map((entry) => entry.guid).sort()).toEqual([patchGroup.guid, minorGroup.guid].sort());
    expect(declaredGroups(result.workflow.nodes[0])).toEqual([{ guid: patchGroup.guid, version: "1.0.1" }]);
    expect(declaredGroups(result.workflow.nodes[1])).toEqual([{ guid: minorGroup.guid, version: "1.1.0" }]);
    expect(declaredGroups(result.workflow.nodes[2])).toEqual([{ guid: majorGroup.guid, version: "1.0.0" }]);
  });
});
