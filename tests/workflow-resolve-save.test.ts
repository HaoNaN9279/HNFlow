// 工作流保存集成测试（v0.3.0 T5）：saveWorkflow resolver 钩子 + resolvedGroups/resolvedAt 元数据。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { GroupResolveError } from "../src/groups/errors.js";
import { initGroup } from "../src/groups/init.js";
import { resolveWorkflowGroups } from "../src/groups/resolve.js";
import type { Node, Workflow } from "../src/model/types.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\workflow-resolve-save-test";

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

/** 携带 rootDir 的解析钩子：saveWorkflow 只认 ResolveResult 形状。 */
function resolveWithRootDir(rootDir: string) {
  return (workflow: Workflow) => resolveWorkflowGroups(rootDir, workflow);
}

async function readSaved(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("saveWorkflow 带 resolver", () => {
  test("解析成功：文件含 resolvedGroups/resolvedAt 元数据", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    const filePath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(filePath, workflow, { resolveGroups: resolveWithRootDir(TEMP_BASE) });

    const saved = await readSaved(filePath);
    expect(saved["resolvedGroups"]).toEqual([`${a.guid}@0.1.0`]);
    expect(saved["resolvedAt"]).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  test("版本缺失：抛 GroupResolveError 且文件未落盘", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "9.9.9" }])]);
    const filePath = join(TEMP_BASE, "wf.json");

    await expect(
      saveWorkflow(filePath, workflow, { resolveGroups: resolveWithRootDir(TEMP_BASE) }),
    ).rejects.toThrow(GroupResolveError);
    await expect(
      saveWorkflow(filePath, workflow, { resolveGroups: resolveWithRootDir(TEMP_BASE) }),
    ).rejects.toThrow(/可用版本/);
    await expect(readFile(filePath, "utf8")).rejects.toThrow(); // 未落盘：文件不存在
  });

  test("声明 guid 不存在：解析抛错透传且文件未落盘", async () => {
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: "no-such-guid", version: "1.0.0" }])]);
    const filePath = join(TEMP_BASE, "wf.json");

    await expect(
      saveWorkflow(filePath, workflow, { resolveGroups: resolveWithRootDir(TEMP_BASE) }),
    ).rejects.toThrow(/不存在/);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  test("既有 resolvedGroups 被新解析刷新覆盖", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const stale: Workflow = {
      ...makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]),
      resolvedGroups: ["stale-guid@0.0.1"],
      resolvedAt: "2000-01-01T00:00:00.000Z",
    };
    const filePath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(filePath, stale, { resolveGroups: resolveWithRootDir(TEMP_BASE) });

    const saved = await readSaved(filePath);
    expect(saved["resolvedGroups"]).toEqual([`${a.guid}@0.1.0`]);
    expect(saved["resolvedAt"]).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  test("loadWorkflow 往返：读回 resolvedGroups/resolvedAt 正确", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    const filePath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(filePath, workflow, { resolveGroups: resolveWithRootDir(TEMP_BASE) });

    const loaded = await loadWorkflow(filePath);
    expect(loaded.resolvedGroups).toEqual([`${a.guid}@0.1.0`]);
    expect(loaded.resolvedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(loaded.id).toBe("wf-1");
    expect(loaded.name).toBe("测试工作流");
  });

  test("入参 workflow 不被修改（resolver 合并不改原对象）", async () => {
    const a = await initGroup(TEMP_BASE, "demo/a");
    const workflow = makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: a.guid, version: "0.1.0" }])]);
    const filePath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(filePath, workflow, { resolveGroups: resolveWithRootDir(TEMP_BASE) });

    expect(workflow.resolvedGroups).toBeUndefined();
    expect(workflow.resolvedAt).toBeUndefined();
  });
});

describe("saveWorkflow 不传 resolver", () => {
  test("保存成功且文件无 resolvedGroups/resolvedAt 字段", async () => {
    const workflow = makeWorkflow([
      { id: "start", type: "start", name: "开始", params: {}, inputs: [], outputs: [] },
    ]);
    const filePath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(filePath, workflow);

    const saved = await readSaved(filePath);
    expect("resolvedGroups" in saved).toBe(false);
    expect("resolvedAt" in saved).toBe(false);
  });

  test("不传 resolver：既有 resolvedGroups 原样保留", async () => {
    const workflow: Workflow = {
      ...makeWorkflow([{ id: "start", type: "start", name: "开始", params: {}, inputs: [], outputs: [] }]),
      resolvedGroups: ["manual@1.0.0"],
      resolvedAt: "2020-01-01T00:00:00.000Z",
    };
    const filePath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(filePath, workflow);

    const loaded = await loadWorkflow(filePath);
    expect(loaded.resolvedGroups).toEqual(["manual@1.0.0"]);
    expect(loaded.resolvedAt).toBe("2020-01-01T00:00:00.000Z");
  });
});
