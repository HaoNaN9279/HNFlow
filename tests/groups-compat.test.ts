// 功能组兼容性校验测试（v0.3.2 T3）：checkCompatibility 比对前后两版本内容，输出变更清单与升级建议级别。
// 覆盖：无上一版本 / 工具删除(breaking) / 工具新增(minor) / parameters canonical 比较 / description(patch) /
// 规则变化(minor) / MCP 变化(minor) / agent 变化(minor) / 完全一致(compatible) / 组合优先级。
import { describe, expect, test } from "bun:test";
import { checkCompatibility, type CompatibilityReport } from "../src/groups/compat.js";
import type { LoadedGroupContent, LoadedMcp, LoadedRule, LoadedTool } from "../src/groups/content-loader.js";

/** 构造 LoadedGroupContent，未提供的集合字段默认空数组。 */
function makeContent(overrides: Partial<LoadedGroupContent> = {}): LoadedGroupContent {
  return {
    guid: "g-playwright",
    namespace: "web/scraping/playwright",
    version: "1.0.0",
    tools: [],
    rules: [],
    mcps: [],
    ...overrides,
  };
}

function makeTool(overrides: Partial<LoadedTool> = {}): LoadedTool {
  return {
    name: "read_file",
    description: "读取文件内容",
    parameters: { path: { type: "string", description: "文件路径" } },
    path: "tools/read_file.json",
    ...overrides,
  };
}

function makeRule(overrides: Partial<LoadedRule> = {}): LoadedRule {
  return { path: "rules/01.md", order: 1, text: "规则一", ...overrides };
}

function makeMcp(overrides: Partial<LoadedMcp> = {}): LoadedMcp {
  return {
    name: "github",
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    path: "mcp.json",
    ...overrides,
  };
}

function kinds(report: CompatibilityReport): readonly string[] {
  return report.changes.map((change) => change.kind);
}

describe("checkCompatibility", () => {
  test("1. prev 为 undefined → compatible 且无变更", () => {
    const report = checkCompatibility(undefined, makeContent());
    expect(report.level).toBe("compatible");
    expect(report.changes).toEqual([]);
  });

  test("2. 工具删除 → breaking，detail 含工具名", () => {
    const report = checkCompatibility(
      makeContent({ tools: [makeTool()] }),
      makeContent({ tools: [] }),
    );
    expect(report.level).toBe("breaking");
    expect(kinds(report)).toEqual(["tool_removed"]);
    expect(report.changes[0]?.detail).toContain("read_file");
  });

  test("3. 工具新增 → minor", () => {
    const report = checkCompatibility(
      makeContent({ tools: [] }),
      makeContent({ tools: [makeTool()] }),
    );
    expect(report.level).toBe("minor");
    expect(kinds(report)).toEqual(["tool_added"]);
  });

  test("4a. 同名工具 parameters 仅 key 顺序不同（值相同）→ compatible", () => {
    const prev = makeContent({ tools: [makeTool({ parameters: { path: { type: "string" }, required: ["path"] } })] });
    const next = makeContent({ tools: [makeTool({ parameters: { required: ["path"], path: { type: "string" } } })] });
    const report = checkCompatibility(prev, next);
    expect(report.level).toBe("compatible");
    expect(report.changes).toEqual([]);
  });

  test("4b. 同名工具 parameters 值不同 → minor(tool_parameters_changed)", () => {
    const prev = makeContent({ tools: [makeTool({ parameters: { path: { type: "string" } } })] });
    const next = makeContent({ tools: [makeTool({ parameters: { path: { type: "string", minLength: 1 } } })] });
    const report = checkCompatibility(prev, next);
    expect(report.level).toBe("minor");
    expect(kinds(report)).toEqual(["tool_parameters_changed"]);
  });

  test("5. 同名工具 description 变化 → patch(tool_description_changed)", () => {
    const report = checkCompatibility(
      makeContent({ tools: [makeTool({ description: "旧描述" })] }),
      makeContent({ tools: [makeTool({ description: "新描述" })] }),
    );
    expect(report.level).toBe("patch");
    expect(kinds(report)).toEqual(["tool_description_changed"]);
  });

  test("6. 规则 text 变化 → minor(rule_changed)，detail 含 path", () => {
    const report = checkCompatibility(
      makeContent({ rules: [makeRule()] }),
      makeContent({ rules: [makeRule({ text: "规则一（修订）" })] }),
    );
    expect(report.level).toBe("minor");
    expect(kinds(report)).toEqual(["rule_changed"]);
    expect(report.changes[0]?.detail).toContain("rules/01.md");
  });

  test("7. mcp config 变化 → minor(mcp_changed)", () => {
    const report = checkCompatibility(
      makeContent({ mcps: [makeMcp()] }),
      makeContent({ mcps: [makeMcp({ config: { command: "npx", args: ["-y", "other-server"] } })] }),
    );
    expect(report.level).toBe("minor");
    expect(kinds(report)).toEqual(["mcp_changed"]);
  });

  test("8. agent 变化（新增/删除/text 变化）→ minor(agent_changed)", () => {
    const added = checkCompatibility(
      makeContent(),
      makeContent({ agent: { text: "你是抓取专家" } }),
    );
    expect(added.level).toBe("minor");
    expect(kinds(added)).toEqual(["agent_changed"]);

    const removed = checkCompatibility(
      makeContent({ agent: { text: "你是抓取专家" } }),
      makeContent(),
    );
    expect(removed.level).toBe("minor");

    const textChanged = checkCompatibility(
      makeContent({ agent: { text: "旧" } }),
      makeContent({ agent: { text: "新" } }),
    );
    expect(textChanged.level).toBe("minor");
  });

  test("9. 前后完全一致 → compatible", () => {
    const prev = makeContent({
      tools: [makeTool()],
      rules: [makeRule()],
      mcps: [makeMcp()],
      agent: { text: "你是抓取专家" },
    });
    const next = makeContent({
      tools: [makeTool()],
      rules: [makeRule()],
      mcps: [makeMcp()],
      agent: { text: "你是抓取专家" },
    });
    const report = checkCompatibility(prev, next);
    expect(report.level).toBe("compatible");
    expect(report.changes).toEqual([]);
  });

  test("10. 组合：breaking + minor → breaking（优先级最高）", () => {
    const report = checkCompatibility(
      makeContent({ tools: [makeTool()] }),
      makeContent({ tools: [makeTool({ name: "write_file" })] }),
    );
    expect(kinds(report)).toEqual(["tool_removed", "tool_added"]);
    expect(report.level).toBe("breaking");
  });
});
