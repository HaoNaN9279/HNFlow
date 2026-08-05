// workflows upgrade 子命令测试（v0.3.2 T7）：按门槛升级声明版本并刷新快照、保存到原文件；忽略文件生效。
// 直接调 cmdWorkflows(["upgrade", ...]) 验证；临时目录用 opencode 专用 temp，Windows 清理惯例（rmRetry + Bun.gc(true)）。
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cmdWorkflows } from "../src/cli/workflows.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";
import type { CapabilityGroup } from "../src/groups/types.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-tests-${randomUUID()}`);

let stdout = "";
let stderr = "";
let code = -1;

/** 重置捕获缓冲并执行 cmdWorkflows；返回退出码。 */
async function runCli(args: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return cmdWorkflows(args);
}

const originalLog = console.log;
const originalError = console.error;
const originalInfo = console.info;
const originalWarn = console.warn;

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

/** 直接构造 group.json（避免 init/release 依赖）；versions 须含锁定版本，currentVersion 为最新。 */
async function writeGroup(
  dir: string,
  namespace: string,
  versions: readonly string[],
  currentVersion: string,
): Promise<{ guid: string; namespace: string }> {
  const guid = randomUUID();
  const groupDir = join(dir, ...namespace.split("/"));
  await mkdir(groupDir, { recursive: true });
  const group: CapabilityGroup = {
    guid,
    namespace,
    aliases: [],
    description: "",
    versions: versions.map((version, index) => ({
      version,
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
      changelog: `更新 ${version}`,
      content: { tools: [], mcps: [], rules: [] },
    })),
    currentVersion,
  };
  await writeFile(join(groupDir, "group.json"), `${JSON.stringify(group, null, 2)}\n`, "utf8");
  return { guid, namespace };
}

function makeWorkflow(nodes: readonly Node[], resolvedGroups: readonly string[]): Workflow {
  return {
    id: "wf-upgrade",
    name: "升级测试工作流",
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

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rmRetry(TEMP_BASE);
  await mkdir(TEMP_BASE, { recursive: true });
  stdout = "";
  stderr = "";
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  console.info = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.warn = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.info = originalInfo;
  console.warn = originalWarn;
});

describe("workflows upgrade 子命令", () => {
  test("--patch 只升 patch 级（minor/major 不动）", async () => {
    const patchGroup = await writeGroup(TEMP_BASE, "demo/patch", ["0.1.0", "1.0.0", "1.0.1"], "1.0.1");
    const minorGroup = await writeGroup(TEMP_BASE, "demo/minor", ["0.1.0", "1.0.0", "1.1.0"], "1.1.0");
    const majorGroup = await writeGroup(TEMP_BASE, "demo/major", ["0.1.0", "1.0.0", "2.0.0"], "2.0.0");
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(
      wfPath,
      makeWorkflow(
        [
          declareNode("ai-1", "AI 节点", [{ guid: patchGroup.guid, version: "1.0.0" }]),
          declareNode("ai-2", "AI 节点", [{ guid: minorGroup.guid, version: "1.0.0" }]),
          declareNode("ai-3", "AI 节点", [{ guid: majorGroup.guid, version: "1.0.0" }]),
        ],
        [`${patchGroup.guid}@1.0.0`, `${minorGroup.guid}@1.0.0`, `${majorGroup.guid}@1.0.0`],
      ),
    );

    code = await runCli(["upgrade", wfPath, "--groups", TEMP_BASE, "--patch"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`${patchGroup.guid}@1.0.0 → 1.0.1（patch）`);
    expect(stdout).not.toContain(minorGroup.guid);
    expect(stdout).not.toContain(majorGroup.guid);
    expect(stdout).toContain("已保存");
  });

  test("--all 全升（patch/minor/major）", async () => {
    const patchGroup = await writeGroup(TEMP_BASE, "demo/patch", ["0.1.0", "1.0.0", "1.0.1"], "1.0.1");
    const minorGroup = await writeGroup(TEMP_BASE, "demo/minor", ["0.1.0", "1.0.0", "1.1.0"], "1.1.0");
    const majorGroup = await writeGroup(TEMP_BASE, "demo/major", ["0.1.0", "1.0.0", "2.0.0"], "2.0.0");
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(
      wfPath,
      makeWorkflow(
        [
          declareNode("ai-1", "AI 节点", [{ guid: patchGroup.guid, version: "1.0.0" }]),
          declareNode("ai-2", "AI 节点", [{ guid: minorGroup.guid, version: "1.0.0" }]),
          declareNode("ai-3", "AI 节点", [{ guid: majorGroup.guid, version: "1.0.0" }]),
        ],
        [`${patchGroup.guid}@1.0.0`, `${minorGroup.guid}@1.0.0`, `${majorGroup.guid}@1.0.0`],
      ),
    );

    code = await runCli(["upgrade", wfPath, "--groups", TEMP_BASE, "--all"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`${patchGroup.guid}@1.0.0 → 1.0.1（patch）`);
    expect(stdout).toContain(`${minorGroup.guid}@1.0.0 → 1.1.0（minor）`);
    expect(stdout).toContain(`${majorGroup.guid}@1.0.0 → 2.0.0（major）`);
  });

  test("无 flag（预览）不升级任何档", async () => {
    const group = await writeGroup(TEMP_BASE, "demo/patch", ["0.1.0", "1.0.0", "1.0.1"], "1.0.1");
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(
      wfPath,
      makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: group.guid, version: "1.0.0" }])], [
        `${group.guid}@1.0.0`,
      ]),
    );

    code = await runCli(["upgrade", wfPath, "--groups", TEMP_BASE]);
    expect(code).toBe(0);
    expect(stdout).toContain("没有可升级的功能组");
    expect(stdout).not.toContain("已保存");
  });

  test("保存后文件内容已更新（capabilityGroups 版本 + resolvedGroups 快照）", async () => {
    const group = await writeGroup(TEMP_BASE, "demo/a", ["0.1.0", "1.0.0", "1.0.1"], "1.0.1");
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(
      wfPath,
      makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: group.guid, version: "1.0.0" }])], [
        `${group.guid}@1.0.0`,
      ]),
    );

    code = await runCli(["upgrade", wfPath, "--groups", TEMP_BASE, "--patch"]);
    expect(code).toBe(0);

    const saved = await loadWorkflow(wfPath);
    expect(saved.nodes[0]?.params["capabilityGroups"]).toEqual([{ guid: group.guid, version: "1.0.1" }]);
    expect(saved.resolvedGroups).toContain(`${group.guid}@1.0.1`);
  });

  test("忽略文件生效：命中项不升级", async () => {
    const group = await writeGroup(TEMP_BASE, "demo/a", ["0.1.0", "1.0.0", "1.0.1"], "1.0.1");
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(
      wfPath,
      makeWorkflow([declareNode("ai-1", "AI 节点", [{ guid: group.guid, version: "1.0.0" }])], [
        `${group.guid}@1.0.0`,
      ]),
    );
    await writeFile(
      join(TEMP_BASE, ".hnflow-updates.json"),
      JSON.stringify({ ignored: [`${group.guid}@1.0.0`] }),
      "utf8",
    );

    code = await runCli(["upgrade", wfPath, "--groups", TEMP_BASE, "--patch"]);
    expect(code).toBe(0);
    expect(stdout).toContain("没有可升级的功能组");
  });

  test("缺 file → fail 非 0 + 用法提示", async () => {
    code = await runCli(["upgrade"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("缺少工作流文件");
    expect(stderr).toContain("用法");
  });
});
