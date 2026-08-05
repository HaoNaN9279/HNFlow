// 执行引擎功能组注入测试（v0.3.1 T5）：
// 节点 capabilityGroups 声明 → ctx.activeGroups 注入合并结果 / 无声明或未配置不注入 /
// 加载失败直接 Failed（错误含 guid@version+原因）/ 跨节点缓存复用（LRU）/ 子图透传。
// 夹具惯例照 tests/groups-runtime.test.ts（临时目录构造功能组）+ tests/engine.test.ts（引擎测试惯例）。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { GroupsResolver } from "../src/execution/groups-resolver.js";
import type { INodeDefinition, MergedGroups, NodeExecutionContext } from "../src/execution/types.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\engine-groups-test";

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
  capturedActiveGroups = undefined;
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

/** 构造合法 group.json 数据。 */
function makeGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: "g-playwright",
    namespace: "web/scraping/playwright",
    aliases: [],
    description: "Playwright 抓取能力组",
    currentVersion: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: "初版",
        content: {
          agent: "agent.md",
          tools: ["navigate.ts"],
          mcps: ["mcp.json"],
          rules: [{ path: "rules/01-navigation.md", order: 1 }],
        },
      },
    ],
    ...overrides,
  };
}

async function writeGroupJson(dir: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "group.json"), JSON.stringify(data), "utf8");
}

/** 写入功能组定义 + 版本目录实际内容文件（agent.md / navigate.ts / mcp.json / rules）。 */
async function writeGroup(base: string, guid: string, namespace: string, versions: string[]): Promise<void> {
  const firstVersion = versions[0];
  if (firstVersion === undefined) {
    throw new Error("writeGroup 至少需要一个版本");
  }
  const groupDir = join(base, ...namespace.split("/"));
  await writeGroupJson(
    groupDir,
    makeGroup({
      guid,
      namespace,
      currentVersion: firstVersion,
      versions: versions.map((version) => ({
        version,
        createdAt: "2026-08-01T00:00:00.000Z",
        changelog: `版本 ${version}`,
        content: {
          agent: "agent.md",
          tools: ["navigate.ts"],
          mcps: ["mcp.json"],
          rules: [{ path: "rules/01-navigation.md", order: 1 }],
        },
      })),
    }),
  );
  for (const version of versions) {
    const versionDir = join(groupDir, `v${version}`);
    await mkdir(join(versionDir, "rules"), { recursive: true });
    await writeFile(join(versionDir, "agent.md"), `# ${guid} agent ${version}\n`, "utf8");
    await writeFile(
      join(versionDir, "navigate.ts"),
      JSON.stringify({ name: "navigate", description: "导航能力", parameters: { type: "object" } }),
      "utf8",
    );
    await writeFile(
      join(versionDir, "mcp.json"),
      JSON.stringify({ name: "demo-mcp", url: "http://localhost:9999" }),
      "utf8",
    );
    await writeFile(join(versionDir, "rules", "01-navigation.md"), "# 导航规则\n", "utf8");
  }
}

// ---- 捕获节点：execute 里把 ctx.activeGroups 存入模块级变量供断言 ----
let capturedActiveGroups: MergedGroups | undefined;

const captureGroupsDef: INodeDefinition = {
  type: "captureGroups",
  name: "captureGroups",
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  async execute(ctx: NodeExecutionContext) {
    capturedActiveGroups = ctx.activeGroups;
    return { out: true };
  },
};

const customRegistry = new NodeRegistry();
for (const def of builtinNodes) customRegistry.register(def);
customRegistry.register(captureGroupsDef);

/** 按自定义注册表构造内置类型节点（端口取自注册表定义）。 */
function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = customRegistry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

/** 捕获节点（含 in/out 端口，便于子图 validateWorkflow 校验）。 */
function makeCaptureNode(id: string, params: Readonly<Record<string, unknown>> = {}): Node {
  return {
    id,
    type: "captureGroups",
    name: id,
    params,
    inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
    outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
  };
}

/** 仅测试 GroupsResolver 缓存的裸节点（resolve 只消费 id/name/params）。 */
function groupNode(id: string, guid: string, version: string): Node {
  return {
    id,
    type: "captureGroups",
    name: id,
    params: { capabilityGroups: [{ guid, version }] },
    inputs: [],
    outputs: [],
  };
}

/** 最简工作流：start → cap(captureGroups) → end。 */
function makeSimpleWorkflow(capParams: Readonly<Record<string, unknown>>): Workflow {
  return {
    id: "inject-wf",
    name: "inject",
    version: "0.1.0",
    nodes: [makeNode("start", "start"), makeCaptureNode("cap", capParams), makeNode("end", "end")],
    edges: [
      { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "cap", targetPortId: "in" },
      { id: "e2", sourceNodeId: "cap", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
    ],
  };
}

describe("引擎注入 activeGroups", () => {
  test("节点声明 capabilityGroups + 引擎配 groupsRootDir → ctx.activeGroups 注入合并结果", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const workflow = makeSimpleWorkflow({
      capabilityGroups: [{ guid: "g-playwright", version: "1.0.0" }],
    });
    const result = await new ExecutionEngine(workflow, {
      registry: customRegistry,
      groupsRootDir: TEMP_BASE,
    }).run();
    expect(result.status).toBe("success");
    const groups = capturedActiveGroups;
    expect(groups).toBeDefined();
    if (groups === undefined) {
      throw new Error("expected activeGroups to be injected");
    }
    expect(groups.agent?.text).toContain("g-playwright agent 1.0.0");
    expect(groups.tools[0]?.fullName).toBe("web/scraping/playwright.navigate");
    expect(groups.tools[0]?.sourceGuid).toBe("g-playwright");
    expect(groups.mcps[0]?.name).toBe("demo-mcp");
    expect(groups.rules[0]?.path).toBe("rules/01-navigation.md");
  });

  test("节点无 capabilityGroups 声明 → ctx.activeGroups 不注入（undefined）", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const result = await new ExecutionEngine(makeSimpleWorkflow({}), {
      registry: customRegistry,
      groupsRootDir: TEMP_BASE,
    }).run();
    expect(result.status).toBe("success");
    expect(capturedActiveGroups).toBeUndefined();
  });

  test("引擎未配置 groupsRootDir → 声明了也不注入（undefined）", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const result = await new ExecutionEngine(makeSimpleWorkflow({
      capabilityGroups: [{ guid: "g-playwright", version: "1.0.0" }],
    }), {
      registry: customRegistry,
    }).run();
    expect(result.status).toBe("success");
    expect(capturedActiveGroups).toBeUndefined();
  });

  test("功能组加载失败（guid 不存在）→ 节点 Failed，错误含 guid@version 与原因", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const result = await new ExecutionEngine(makeSimpleWorkflow({
      capabilityGroups: [{ guid: "g-unknown", version: "1.0.0" }],
    }), {
      registry: customRegistry,
      groupsRootDir: TEMP_BASE,
    }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["cap"]).toBe("Failed");
    if (result.error === undefined) {
      throw new Error("expected error message");
    }
    expect(result.error).toContain("g-unknown@1.0.0");
    expect(result.error).toContain("功能组不存在");
  });

  test("声明非法（非数组）→ 节点 Failed，错误含节点路径定位", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const result = await new ExecutionEngine(makeSimpleWorkflow({
      capabilityGroups: "g-playwright@1.0.0",
    }), {
      registry: customRegistry,
      groupsRootDir: TEMP_BASE,
    }).run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("cap");
  });
});

describe("引擎跨节点缓存复用", () => {
  test("多节点声明同功能组 → 各自注入且内容一致（功能正确）", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const workflow: Workflow = {
      id: "multi-wf",
      name: "multi",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeCaptureNode("cap1", { capabilityGroups: [{ guid: "g-playwright", version: "1.0.0" }] }),
        makeCaptureNode("cap2", { capabilityGroups: [{ guid: "g-playwright", version: "1.0.0" }] }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "cap1", targetPortId: "in" },
        { id: "e2", sourceNodeId: "cap1", sourcePortId: "out", targetNodeId: "cap2", targetPortId: "in" },
        { id: "e3", sourceNodeId: "cap2", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(workflow, {
      registry: customRegistry,
      groupsRootDir: TEMP_BASE,
    }).run();
    expect(result.status).toBe("success");
    expect(capturedActiveGroups?.agent?.text).toContain("g-playwright agent 1.0.0");
  });

  test("GroupsResolver 跨节点同功能组 → diskReadCount=1（LRU 缓存复用）", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const resolver = new GroupsResolver({ groupsRootDir: TEMP_BASE });
    const first = await resolver.resolve(groupNode("n1", "g-playwright", "1.0.0"));
    const second = await resolver.resolve(groupNode("n2", "g-playwright", "1.0.0"));
    expect(first?.agent?.text).toContain("g-playwright agent 1.0.0");
    expect(second?.agent?.text).toContain("g-playwright agent 1.0.0");
    expect(resolver.diskReadCount).toBe(1);
  });
});

describe("子图透传", () => {
  test("subworkflow 子图内节点声明 capabilityGroups → 子引擎透传 groupsRootDir 后注入 activeGroups", async () => {
    await writeGroup(TEMP_BASE, "g-playwright", "web/scraping/playwright", ["1.0.0"]);
    const sub: Workflow = {
      id: "sub-groups",
      name: "子图",
      version: "0.1.0",
      nodes: [
        makeNode("sub-start", "start"),
        makeCaptureNode("sub-cap", { capabilityGroups: [{ guid: "g-playwright", version: "1.0.0" }] }),
        makeNode("sub-end", "end"),
      ],
      edges: [
        { id: "s1", sourceNodeId: "sub-start", sourcePortId: "data", targetNodeId: "sub-cap", targetPortId: "in" },
        { id: "s2", sourceNodeId: "sub-cap", sourcePortId: "out", targetNodeId: "sub-end", targetPortId: "in" },
      ],
    };
    const parent: Workflow = {
      id: "parent-groups",
      name: "parent",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sub", "subworkflow", { subworkflow: sub }),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent, {
      registry: customRegistry,
      groupsRootDir: TEMP_BASE,
    }).run();
    expect(result.status).toBe("success");
    expect(capturedActiveGroups?.agent?.text).toContain("g-playwright agent 1.0.0");
  });
});
