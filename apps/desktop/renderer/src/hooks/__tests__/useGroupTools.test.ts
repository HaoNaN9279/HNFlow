// useGroupTools.ts buildGroupItems 废弃标记透传单测（无 DOM/X6 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/hooks/__tests__/useGroupTools.test.ts`。
// 顶部 triple-slash 引用 bun 类型：本文件位于 renderer/src（tsconfig types 仅 vite/client），
// 显式加载 bun-types 使 tsc 能解析 "bun:test" 模块。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { GroupSummary } from "../../../../src/shared/ipc.js";
import { buildGroupItems } from "../useGroupTools.js";

/** 便捷构造功能组摘要：versions 仅含 currentVersion 对应快照（deprecated 可选覆盖）。 */
function group(
  namespace: string,
  overrides: Partial<GroupSummary> = {},
  deprecated?: boolean,
): GroupSummary {
  return {
    namespace,
    currentVersion: "1.0.0",
    tools: [],
    mcps: [],
    versions: [{ version: "1.0.0", createdAt: "2026-08-01T00:00:00.000Z", changelog: "初版", ...(deprecated === undefined ? {} : { deprecated }) }],
    ...overrides,
  };
}

describe("buildGroupItems deprecated 透传", () => {
  it("当前版本 deprecated=true → 分组带 deprecated: true", () => {
    const result = buildGroupItems([group("release", {}, true)]);
    expect(result[0]?.deprecated).toBe(true);
  });

  it("当前版本 deprecated=false → 分组带 deprecated: false", () => {
    const result = buildGroupItems([group("release", {}, false)]);
    expect(result[0]?.deprecated).toBe(false);
  });

  it("未声明 deprecated → 分组不带 deprecated 键（undefined）", () => {
    const result = buildGroupItems([group("release")]);
    expect(result[0]?.deprecated).toBeUndefined();
    expect("deprecated" in (result[0] ?? {})).toBe(false);
  });

  it("versions 无 currentVersion 快照 → 分组不带 deprecated 键（防御）", () => {
    const result = buildGroupItems([
      group("release", { currentVersion: "9.9.9", versions: [{ version: "1.0.0", createdAt: "2026-08-01T00:00:00.000Z", changelog: "初版", deprecated: true }] }),
    ]);
    expect(result[0]?.deprecated).toBeUndefined();
  });

  it("多组各自透传互不干扰", () => {
    const result = buildGroupItems([group("legacy", {}, true), group("fresh", {}, false), group("plain")]);
    expect(result.map((g) => g.deprecated)).toEqual([true, false, undefined]);
  });
});
