// 核心版本兼容校验测试（v0.3.2 T8）：
// assertCoreCompatible 直接单测 + content-loader 透传 + GroupsResolver/Engine 集成（默认抛错、allowIncompatibleGroups 宽松）。
// 夹具惯例照 tests/groups-content-loader.test.ts（临时目录）+ tests/ai-e2e.test.ts（start→ai→end）。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCoreCompatible, CORE_VERSION } from "../src/execution/core-version.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { GroupsResolver } from "../src/execution/groups-resolver.js";
import { loadGroupContent } from "../src/groups/content-loader.js";
import type { CapabilityGroup, GroupContent } from "../src/groups/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

const TEMP_BASE = `C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\hnflow-tests-${Date.now().toString(36)}`;

afterAll(async () => {
  await rmRetry(TEMP_BASE);
  Bun.gc(true);
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

// ---- 功能组夹具：requiresCoreVersion 按需出现（exactOptionalPropertyTypes） ----

function makeGroupContent(requiresCoreVersion: string | undefined): GroupContent {
  const content: GroupContent = {
    agent: "agent.md",
    tools: ["navigate.ts"],
    mcps: ["mcp.json"],
    rules: [{ path: "rules/01-navigation.md", order: 1 }],
  };
  return requiresCoreVersion === undefined ? content : { ...content, requiresCoreVersion };
}

function makeGroup(requiresCoreVersion: string | undefined): CapabilityGroup {
  return {
    guid: "g-core",
    namespace: "core/ver",
    aliases: [],
    description: "核心版本校验组",
    currentVersion: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: "初版",
        content: makeGroupContent(requiresCoreVersion),
      },
    ],
  };
}

/** 写功能组定义 + 版本目录内容文件（agent.md / navigate.ts / mcp.json / rules）。 */
async function writeGroupFiles(base: string, requiresCoreVersion: string | undefined): Promise<void> {
  const groupDir = join(base, "core", "ver");
  await mkdir(groupDir, { recursive: true });
  await writeFile(join(groupDir, "group.json"), JSON.stringify(makeGroup(requiresCoreVersion)), "utf8");
  const versionDir = join(groupDir, "v1.0.0");
  await mkdir(join(versionDir, "rules"), { recursive: true });
  await writeFile(join(versionDir, "agent.md"), "# g-core agent\n", "utf8");
  await writeFile(
    join(versionDir, "navigate.ts"),
    JSON.stringify({ name: "navigate", description: "导航能力", parameters: { type: "object" } }),
    "utf8",
  );
  await writeFile(join(versionDir, "mcp.json"), JSON.stringify({ name: "demo-mcp", url: "http://localhost:9999" }), "utf8");
  await writeFile(join(versionDir, "rules", "01-navigation.md"), "# 导航规则\n", "utf8");
}

// ---- 节点 / 工作流夹具 ----

/** 按注册表端口模板构造节点（start/ai/end 均来自内置注册表）。 */
function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** 仅测试 GroupsResolver 的裸节点（resolve 只消费 id/name/params）。 */
function groupNode(id: string, guid: string, version: string): Node {
  return {
    id,
    type: "ai",
    name: id,
    params: { capabilityGroups: [{ guid, version }] },
    inputs: [],
    outputs: [],
  };
}

/** start → ai → end 三节点工作流（ai 节点 params 含 capabilityGroups 声明）。 */
function buildWorkflow(aiParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "core-version-wf",
    name: "core-version",
    version: "0.1.0",
    nodes: [makeNode("start", "start"), makeNode("ai", "ai", aiParams), makeNode("end", "end")],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ai", targetPortId: "in" },
      { id: "e2", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

function aiParams(): Readonly<Record<string, unknown>> {
  return {
    model: { provider: "fake", model: "test", fakeScript: [{ kind: "text", text: "ok" }] },
    inputMessages: "你好",
    capabilityGroups: [{ guid: "g-core", version: "1.0.0" }],
  };
}

describe("assertCoreCompatible", () => {
  test("requiresCoreVersion undefined → 不抛（无要求即兼容）", () => {
    expect(() => assertCoreCompatible(undefined, { guid: "g", version: "1.0.0" })).not.toThrow();
  });

  test("满足范围（>=0.3.0 <1.0.0）→ 不抛", () => {
    expect(() => assertCoreCompatible(">=0.3.0 <1.0.0", { guid: "g", version: "1.0.0" })).not.toThrow();
  });

  test("不满足范围（>=9.0.0）→ 抛 Error，消息含 guid@version + 要求 + 当前引擎", () => {
    let caught: unknown;
    try {
      assertCoreCompatible(">=9.0.0", { guid: "g-core", version: "1.0.0" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("g-core@1.0.0");
    expect(message).toContain(">=9.0.0");
    expect(message).toContain(CORE_VERSION);
    expect(message).toContain("不兼容");
  });

  test("不满足但 allowIncompatible=true → 不抛（console.warn 提示）", () => {
    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      expect(() =>
        assertCoreCompatible(">=9.0.0", { allowIncompatible: true, guid: "g-core", version: "1.0.0" }),
      ).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warns.some((message) => message.includes("警告:") && message.includes("g-core@1.0.0"))).toBe(true);
  });
});

describe("content-loader requiresCoreVersion 透传", () => {
  test("组带 requiresCoreVersion → 加载后字段存在且值一致", async () => {
    await writeGroupFiles(TEMP_BASE, ">=9.0.0");
    const loaded = await loadGroupContent(TEMP_BASE, makeGroup(">=9.0.0"), "1.0.0");
    expect(loaded.requiresCoreVersion).toBe(">=9.0.0");
  });

  test("组不带 requiresCoreVersion → 加载后字段为 undefined", async () => {
    await writeGroupFiles(TEMP_BASE, undefined);
    const loaded = await loadGroupContent(TEMP_BASE, makeGroup(undefined), "1.0.0");
    expect(loaded.requiresCoreVersion).toBeUndefined();
  });
});

describe("GroupsResolver 核心版本校验", () => {
  test("requiresCoreVersion 不满足 → resolve 抛 Error（含 guid@version + 要求 + 当前引擎）", async () => {
    await writeGroupFiles(TEMP_BASE, ">=9.0.0");
    const resolver = new GroupsResolver({ groupsRootDir: TEMP_BASE });
    let caught: unknown;
    try {
      await resolver.resolve(groupNode("n1", "g-core", "1.0.0"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("g-core@1.0.0");
    expect(message).toContain(">=9.0.0");
    expect(message).toContain(CORE_VERSION);
  });

  test("allowIncompatibleGroups=true → resolve 正常返回合并结果", async () => {
    await writeGroupFiles(TEMP_BASE, ">=9.0.0");
    const resolver = new GroupsResolver({ groupsRootDir: TEMP_BASE, allowIncompatibleGroups: true });
    const groups = await resolver.resolve(groupNode("n1", "g-core", "1.0.0"));
    expect(groups?.tools[0]?.sourceGuid).toBe("g-core");
    expect(groups?.agent?.text).toContain("g-core agent");
  });
});

describe("Engine 核心版本校验集成", () => {
  test("默认（无 allowIncompatibleGroups）→ ai 节点 Failed，错误含不兼容信息", async () => {
    await writeGroupFiles(TEMP_BASE, ">=9.0.0");
    const result = await new ExecutionEngine(buildWorkflow(aiParams()), { groupsRootDir: TEMP_BASE }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["ai"]).toBe("Failed");
    expect(result.error).toContain("g-core@1.0.0");
    expect(result.error).toContain(">=9.0.0");
    expect(result.error).toContain("不兼容");
  });

  test("allowIncompatibleGroups=true → ai 节点正常执行成功", async () => {
    await writeGroupFiles(TEMP_BASE, ">=9.0.0");
    const result = await new ExecutionEngine(buildWorkflow(aiParams()), {
      groupsRootDir: TEMP_BASE,
      allowIncompatibleGroups: true,
    }).run();
    expect(result.status).toBe("success");
    expect(result.nodeStates["ai"]).toBe("Success");
    expect(result.nodeOutputs["ai"]?.["output"]).toBe("ok");
  });
});
