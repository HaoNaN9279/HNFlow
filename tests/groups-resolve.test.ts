// 功能组依赖解析引擎测试（v0.3.0 T4）：resolveWorkflowGroups / supportsRange / 循环检测。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GroupResolveError } from "../src/groups/errors.js";
import { initGroup } from "../src/groups/init.js";
import { loadGroup } from "../src/groups/load.js";
import { releaseGroup } from "../src/groups/release.js";
import {
  detectCircularDependencies,
  detectCircularDependency,
  resolveWorkflowGroups,
  supportsRange,
} from "../src/groups/resolve.js";
import type { CapabilityGroup, GroupDependency } from "../src/groups/types.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-resolve-test";

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

/** 覆盖功能组 v0.1.0 的 dependencies（写回 group.json）。 */
async function setDependencies(namespace: string, dependencies: readonly GroupDependency[]): Promise<void> {
  const group = await loadGroup(join(TEMP_BASE, ...namespace.split("/")));
  const first = group.versions[0];
  if (first === undefined) throw new Error("功能组至少有一个版本");
  const updated: CapabilityGroup = {
    ...group,
    versions: [{ ...first, content: { ...first.content, dependencies } }],
  };
  await writeFile(join(TEMP_BASE, ...namespace.split("/"), "group.json"), JSON.stringify(updated, null, 2), "utf8");
}

describe("supportsRange", () => {
  test("支持 >=、<、<=、组合范围语义", () => {
    expect(supportsRange(">=1.0.0", "1.0.0")).toBe(true);
    expect(supportsRange(">=1.0.0", "2.5.0")).toBe(true);
    expect(supportsRange(">=1.0.0 <2.0.0", "1.5.0")).toBe(true);
    expect(supportsRange(">=1.0.0 <2.0.0", "2.0.0")).toBe(false);
    expect(supportsRange("<1.0.0", "0.9.0")).toBe(true);
    expect(supportsRange("<1.0.0", "1.0.0")).toBe(false);
  });

  test("非法格式保守拒绝（无比较符 / 未知运算符）", () => {
    expect(supportsRange("1.0.0", "1.0.0")).toBe(false);
    expect(supportsRange("~1.0.0", "1.0.0")).toBe(false);
    expect(supportsRange("", "1.0.0")).toBe(false);
  });
});

describe("resolveWorkflowGroups", () => {
  test("收集节点声明并解析 guid@version；多节点同版本去重合并", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    const workflow = makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }]),
      declareNode("ai-2", "另一个节点", [
        { guid: a.guid, version: "0.1.0" },
        { guid: b.guid, version: "0.1.0" },
      ]),
    ]);
    const result = await resolveWorkflowGroups(TEMP_BASE, workflow);
    expect(result.resolvedGroups).toEqual([`${a.guid}@0.1.0`, `${b.guid}@0.1.0`].sort());
    expect(result.cycles).toEqual([]);
    expect(result.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("内嵌 subworkflow 节点的声明被递归收集", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const inner = makeWorkflow([declareNode("inner-ai", "内部 AI", [{ guid: a.guid, version: "0.1.0" }])]);
    const subNode: Node = {
      id: "sub-1",
      type: "subworkflow",
      name: "子工作流",
      params: {},
      inputs: [],
      outputs: [],
      subworkflow: inner,
    };
    const result = await resolveWorkflowGroups(TEMP_BASE, makeWorkflow([subNode]));
    expect(result.resolvedGroups).toEqual([`${a.guid}@0.1.0`]);
  });

  test("声明 guid 不存在：抛错消息含节点路径", async () => {
    const workflow = makeWorkflow([
      declareNode("ai-1", "AI 节点", [{ guid: "no-such-guid", version: "1.0.0" }]),
    ]);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(
      /节点 ai-1 \(AI 节点\) 依赖的功能组 no-such-guid@1\.0\.0 不存在/,
    );
  });

  test("guid 存在但版本不存在：抛错含可用版本", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "9.9.9" }])]);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(/可用版本：0\.1\.0/);
  });

  test("无声明工作流：resolvedGroups 为空数组", async () => {
    const result = await resolveWorkflowGroups(
      TEMP_BASE,
      makeWorkflow([{ id: "start", type: "start", name: "开始", params: {}, inputs: [], outputs: [] }]),
    );
    expect(result.resolvedGroups).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  test("capabilityGroups 形状非法：清晰错误", async () => {
    await expect(
      resolveWorkflowGroups(TEMP_BASE, makeWorkflow([declareNode("ai-1", "AI 节点", "not-array")])),
    ).rejects.toThrow(/capabilityGroups 声明非法/);
    await expect(
      resolveWorkflowGroups(TEMP_BASE, makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: 123, version: "1.0.0" }])])),
    ).rejects.toThrow(/guid 与 version/);
  });

  test("dependencies 展开：A 依赖 B → 结果含 A 与 B", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=0.1.0" }]);
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    const result = await resolveWorkflowGroups(TEMP_BASE, workflow);
    expect(result.resolvedGroups).toEqual([`${a.guid}@0.1.0`, `${b.guid}@0.1.0`].sort());
  });

  test("dependencies 版本范围匹配 currentVersion（>=1.0.0 <2.0.0）", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    await releaseGroup(TEMP_BASE, "demo/b", "1.5.0");
    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=1.0.0 <2.0.0" }]);
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    expect((await resolveWorkflowGroups(TEMP_BASE, workflow)).resolvedGroups).toEqual(
      [`${a.guid}@0.1.0`, `${b.guid}@1.5.0`].sort(),
    );

    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=2.0.0" }]);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(/不满足版本范围/);
  });

  test("dependencies 目标不存在：抛错含被依赖 guid", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    await setDependencies("demo/a", [{ guid: "missing-guid", versionRange: ">=1.0.0" }]);
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(GroupResolveError);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(/missing-guid/);
  });

  test("循环依赖：resolveWorkflowGroups 抛错含完整路径 A→B→C→A", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    const c = await initGroup(TEMP_BASE, "demo/c");
    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=0.1.0" }]);
    await setDependencies("demo/b", [{ guid: c.guid, versionRange: ">=0.1.0" }]);
    await setDependencies("demo/c", [{ guid: a.guid, versionRange: ">=0.1.0" }]);
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(/循环依赖/);
    await expect(resolveWorkflowGroups(TEMP_BASE, workflow)).rejects.toThrow(
      `${a.guid}→${b.guid}→${c.guid}→${a.guid}`,
    );
  });
});

describe("循环检测独立函数", () => {
  test("detectCircularDependency 返回完整环路径", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    const c = await initGroup(TEMP_BASE, "demo/c");
    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=0.1.0" }]);
    await setDependencies("demo/b", [{ guid: c.guid, versionRange: ">=0.1.0" }]);
    await setDependencies("demo/c", [{ guid: a.guid, versionRange: ">=0.1.0" }]);
    expect(await detectCircularDependency(TEMP_BASE, a.guid)).toEqual([a.guid, b.guid, c.guid, a.guid]);
  });

  test("无环组：单点返回 undefined，全量返回空数组", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=0.1.0" }]);
    expect(await detectCircularDependency(TEMP_BASE, a.guid)).toBeUndefined();
    expect(await detectCircularDependencies(TEMP_BASE)).toEqual([]);
  });

  test("detectCircularDependencies 全量返回所有环（A→B→C→A）", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const b = await initGroup(TEMP_BASE, "demo/b");
    const c = await initGroup(TEMP_BASE, "demo/c");
    await setDependencies("demo/a", [{ guid: b.guid, versionRange: ">=0.1.0" }]);
    await setDependencies("demo/b", [{ guid: c.guid, versionRange: ">=0.1.0" }]);
    await setDependencies("demo/c", [{ guid: a.guid, versionRange: ">=0.1.0" }]);
    const cycles = await detectCircularDependencies(TEMP_BASE);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([a.guid, b.guid, c.guid, a.guid]);
  });
});
