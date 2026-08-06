// v0.4.3 验收 1 功能组物料组装纯函数单测（无 DOM/X6 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/editor/__tests__/group-items.test.ts`。
// 顶部 triple-slash 引用 bun 类型：本文件位于 renderer/src（tsconfig types 仅 vite/client），
// 显式加载 bun-types 使 tsc 能解析 "bun:test" 模块。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { GroupSummary } from "../../../../src/shared/ipc.js";
import { buildGroupItems, buildMcpToolNode } from "../../hooks/useGroupTools.js";

/** 便捷构造功能组摘要：默认无工具无 MCP。 */
function group(
  namespace: string,
  overrides: Partial<GroupSummary> = {},
): GroupSummary {
  return {
    namespace,
    currentVersion: "1.0.0",
    tools: [],
    mcps: [],
    ...overrides,
  };
}

describe("buildGroupItems", () => {
  it("每个功能组命名空间一个分组（key/label 派生）", () => {
    const result = buildGroupItems([group("release"), group("data")]);
    expect(result.map((g) => [g.key, g.label])).toEqual([
      ["group:release", "release"],
      ["group:data", "data"],
    ]);
  });

  it("MCP 配置 command 为字符串 → 可拖拽 mcp 物料（bound=true）", () => {
    const result = buildGroupItems([
      group("release", {
        mcps: [
          { name: "fetch", config: { command: "npx", args: ["-y", "@mcp/fetch"] } },
          { name: "no-command", config: { host: "localhost" } },
          { name: "bad-command", config: { command: 123 } },
        ],
      }),
    ]);
    const items = result[0]?.items ?? [];
    expect(items).toHaveLength(1);
    const mcp = items[0];
    expect(mcp?.kind).toBe("mcp");
    expect(mcp?.bound).toBe(true);
    if (mcp?.kind === "mcp") {
      expect(mcp.serverName).toBe("fetch");
      expect(mcp.toolName).toBe("");
      expect(mcp.mcpConfig).toEqual({ command: "npx", args: ["-y", "@mcp/fetch"] });
    }
  });

  it("声明工具 → 未绑定 declared 物料（bound=false，无 server 字段）", () => {
    const result = buildGroupItems([
      group("release", { tools: [{ name: "publish", description: "发布到远程" }] }),
    ]);
    const item = result[0]?.items[0];
    expect(item?.kind).toBe("declared");
    expect(item?.bound).toBe(false);
    expect(item?.serverName).toBeUndefined();
    expect(item?.mcpConfig).toBeUndefined();
  });

  it("MCP 与声明工具同组共存时各自成条目", () => {
    const result = buildGroupItems([
      group("release", {
        tools: [{ name: "publish", description: "发布" }],
        mcps: [{ name: "publish", config: { command: "node", args: ["server.js"] } }],
      }),
    ]);
    expect(result[0]?.items.map((i) => i.kind)).toEqual(["mcp", "declared"]);
  });

  it("空列表 → 空分组数组", () => {
    expect(buildGroupItems([])).toEqual([]);
  });
});

describe("buildMcpToolNode", () => {
  it("mcp 物料 → mcpTool 节点（serverName/toolName/mcpConfig/args 快照）", () => {
    const items = buildGroupItems([
      group("release", { mcps: [{ name: "fetch", config: { command: "npx" } }] }),
    ]);
    const mcp = items[0]?.items[0];
    expect(mcp?.kind).toBe("mcp");
    if (mcp?.kind !== "mcp") {
      throw new Error("构造失败：预期存在 mcp 物料");
    }
    const node = buildMcpToolNode(mcp, { x: 10, y: 20 });
    expect(node.type).toBe("mcpTool");
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.params).toEqual({
      serverName: "fetch",
      toolName: "",
      mcpConfig: { command: "npx" },
      args: {},
    });
  });

  it("declared 物料 → 抛错（非 MCP 不能生成 mcpTool 节点）", () => {
    const items = buildGroupItems([
      group("release", { tools: [{ name: "publish", description: "发布" }] }),
    ]);
    const declared = items[0]?.items[0];
    expect(declared?.kind).toBe("declared");
    if (declared?.kind !== "declared") {
      throw new Error("构造失败：预期存在 declared 物料");
    }
    expect(() => buildMcpToolNode(declared, { x: 0, y: 0 })).toThrow();
  });
});
