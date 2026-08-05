// 多功能组合并引擎测试（v0.3.1 T2）：mergeGroups 合并规则 D1-D6。
// 纯函数测试，直接构造 LoadedGroupContent 对象，不依赖文件系统。
// 惯例：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { LoadedGroupContent, LoadedMcp, LoadedRule, LoadedTool } from "../src/groups/content-loader.js";
import { mergeGroups } from "../src/groups/merge.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\groups-merge-test";

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

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

/** 构造工具对象（parameters 带 JSON schema 形状）。 */
function makeTool(name: string, description = `工具 ${name}`): LoadedTool {
  return { name, description, parameters: { type: "object", properties: {} }, path: `tools/${name}.json` };
}

/** 构造规则对象（可带 constraint）。 */
function makeRule(path: string, order: number, text = `# 规则 ${path}`, constraint?: string): LoadedRule {
  return { path, order, text, ...(constraint !== undefined ? { constraint } : {}) };
}

/** 构造 MCP 对象（config 原样透传）。 */
function makeMcp(name: string, config: Record<string, unknown> = {}): LoadedMcp {
  return { name, config, path: "mcp.json" };
}

/** 构造功能组内容：默认 web/scraping/playwright，overrides 覆盖字段。 */
function makeContent(overrides: Partial<LoadedGroupContent> = {}): LoadedGroupContent {
  return {
    guid: overrides.guid ?? "g-web",
    namespace: overrides.namespace ?? "web/scraping/playwright",
    version: overrides.version ?? "1.0.0",
    ...(overrides.agent !== undefined ? { agent: overrides.agent } : {}),
    tools: overrides.tools ?? [],
    rules: overrides.rules ?? [],
    mcps: overrides.mcps ?? [],
  };
}

describe("mergeGroups agent 优先级（D1）", () => {
  test("两个组都有 agent：第一个生效，第二个进 supplementaryAgents", () => {
    const g1 = makeContent({ agent: { text: "agent-one" } });
    const g2 = makeContent({ guid: "g-code", namespace: "code/review", agent: { text: "agent-two" } });
    const result = mergeGroups([g1, g2]);
    expect(result.agent).toEqual({ text: "agent-one", sourceGuid: "g-web", sourceNamespace: "web/scraping/playwright" });
    expect(result.supplementaryAgents).toEqual([
      { text: "agent-two", sourceGuid: "g-code", sourceNamespace: "code/review" },
    ]);
  });

  test("第一个有 agent 的组生效（前面无 agent 组跳过）", () => {
    const none = makeContent({ guid: "g-none" });
    const first = makeContent({ guid: "g-first", agent: { text: "first" } });
    const second = makeContent({ guid: "g-second", agent: { text: "second" } });
    const result = mergeGroups([none, first, second]);
    expect(result.agent).toEqual({ text: "first", sourceGuid: "g-first", sourceNamespace: "web/scraping/playwright" });
    expect(result.supplementaryAgents).toEqual([
      { text: "second", sourceGuid: "g-second", sourceNamespace: "web/scraping/playwright" },
    ]);
  });

  test("无 agent 组：agent 字段省略", () => {
    const result = mergeGroups([makeContent()]);
    expect(result.agent).toBeUndefined();
    expect(result.supplementaryAgents).toEqual([]);
  });
});

describe("mergeGroups 工具命名空间（D2）", () => {
  test("同名工具在不同组：fullName 加各自 namespace 前缀", () => {
    const g1 = makeContent({ tools: [makeTool("read_file")] });
    const g2 = makeContent({ guid: "g-code", namespace: "code/review", tools: [makeTool("read_file")] });
    const result = mergeGroups([g1, g2]);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]).toEqual({
      fullName: "web/scraping/playwright.read_file",
      namespace: "web/scraping/playwright",
      baseName: "read_file",
      description: "工具 read_file",
      parameters: { type: "object", properties: {} },
      sourceGuid: "g-web",
      sourceVersion: "1.0.0",
    });
    expect(result.tools[1]).toEqual({
      fullName: "code/review.read_file",
      namespace: "code/review",
      baseName: "read_file",
      description: "工具 read_file",
      parameters: { type: "object", properties: {} },
      sourceGuid: "g-code",
      sourceVersion: "1.0.0",
    });
  });

  test("无 namespace 组：工具不加前缀（fullName = baseName）", () => {
    const g = makeContent({ namespace: "", tools: [makeTool("read_file")] });
    const result = mergeGroups([g]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.fullName).toBe("read_file");
    expect(result.tools[0]?.namespace).toBe("");
    expect(result.tools[0]?.baseName).toBe("read_file");
  });
});

describe("mergeGroups rules 排序（D3）", () => {
  test("组加载顺序优先，组内按 order 升序", () => {
    const g1 = makeContent({ rules: [makeRule("g1-o2", 2), makeRule("g1-o1", 1)] });
    const g2 = makeContent({ guid: "g-code", namespace: "code/review", rules: [makeRule("g2-o1", 1), makeRule("g2-o2", 2)] });
    const result = mergeGroups([g1, g2]);
    expect(result.rules.map((rule) => rule.path)).toEqual(["g1-o1", "g1-o2", "g2-o1", "g2-o2"]);
    expect(result.rules.map((rule) => rule.order)).toEqual([1, 2, 1, 2]);
    expect(result.rules[0]?.sourceGuid).toBe("g-web");
    expect(result.rules[2]?.sourceGuid).toBe("g-code");
    expect(result.rules[2]?.sourceNamespace).toBe("code/review");
  });
});

describe("mergeGroups 规则互斥检测（D4）", () => {
  test("不同 constraint：冲突成对收集", () => {
    const g = makeContent({ rules: [makeRule("a", 1, "…", "json"), makeRule("b", 2, "…", "markdown")] });
    const result = mergeGroups([g]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({ rulePathA: "a", rulePathB: "b", constraintA: "json", constraintB: "markdown" });
  });

  test("同值 constraint：不冲突", () => {
    const g = makeContent({ rules: [makeRule("a", 1, "…", "json"), makeRule("b", 2, "…", "json")] });
    expect(mergeGroups([g]).conflicts).toEqual([]);
  });

  test("constraint 都 undefined：不冲突", () => {
    const g = makeContent({ rules: [makeRule("a", 1), makeRule("b", 2)] });
    expect(mergeGroups([g]).conflicts).toEqual([]);
  });

  test("一对冲突只报一次（跨组同 path 规则）", () => {
    const g1 = makeContent({ rules: [makeRule("shared", 1, "…", "json")] });
    const g2 = makeContent({ guid: "g-code", namespace: "code/review", rules: [makeRule("shared", 1, "…", "markdown")] });
    const result = mergeGroups([g1, g2]);
    expect(result.conflicts).toHaveLength(1);
  });

  test("三个不同 constraint：两两成对（3 对）", () => {
    const g = makeContent({ rules: [makeRule("a", 1, "…", "json"), makeRule("b", 2, "…", "markdown"), makeRule("c", 3, "…", "xml")] });
    expect(mergeGroups([g]).conflicts).toHaveLength(3);
  });
});

describe("mergeGroups mcps 覆盖（D5）", () => {
  test("同名 mcp：靠前覆盖靠后，只保留第一个", () => {
    const g1 = makeContent({ mcps: [makeMcp("browser", { command: "npx", args: ["@browser-v1"] })] });
    const g2 = makeContent({ guid: "g-code", namespace: "code/review", mcps: [makeMcp("browser", { command: "npx", args: ["@browser-v2"] })] });
    const result = mergeGroups([g1, g2]);
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0]).toEqual({ name: "browser", config: { command: "npx", args: ["@browser-v1"] }, sourceGuid: "g-web" });
  });

  test("不同名 mcp：全部保留", () => {
    const g1 = makeContent({ mcps: [makeMcp("a")] });
    const g2 = makeContent({ guid: "g-code", namespace: "code/review", mcps: [makeMcp("b")] });
    expect(mergeGroups([g1, g2]).mcps).toHaveLength(2);
  });
});

describe("mergeGroups 不修改入参（D6）", () => {
  test("原对象深比较不变", () => {
    const g1 = makeContent({
      agent: { text: "a" },
      tools: [makeTool("read_file")],
      rules: [makeRule("r", 1, "…", "json")],
      mcps: [makeMcp("browser", { command: "npx" })],
    });
    const g2 = makeContent({
      guid: "g-code",
      namespace: "code/review",
      agent: { text: "b" },
      tools: [makeTool("read_file")],
      rules: [makeRule("r", 1, "…", "markdown")],
      mcps: [makeMcp("browser", { command: "npx" })],
    });
    const before1 = structuredClone(g1);
    const before2 = structuredClone(g2);
    mergeGroups([g1, g2]);
    expect(g1).toEqual(before1);
    expect(g2).toEqual(before2);
  });
});
