// 幂等性审计测试（v0.9.5 收尾）：防新增节点遗漏幂等标注，标注变更时暴露需同步。
// 枚举 registry.builtinNodes（17 个内置节点）断言：
// 1. 全部节点显式标注 idempotent（boolean，无 undefined/缺失）；
// 2. 非幂等集合精确匹配（command/http/mcpTool/file/ai/llm=false，其余 true）；
// 3. shouldCrashConfirm 决策语义（非幂等+幂等键→true；幂等或 key 缺失→false）。
import { describe, expect, test } from "bun:test";
import { shouldCrashConfirm } from "../src/execution/human-suspend.js";
import { builtinNodes } from "../src/nodes/registry.js";

/** 权威幂等映射：与 src/nodes/registry.ts builtinNodes 标注逐项一致。
 *  变更节点幂等标注须同步更新本映射（测试暴露漂移）；新增节点须在此登记。 */
const EXPECTED_IDEMPOTENT: Record<string, boolean> = {
  start: true,
  end: true,
  ifElse: true,
  setVariable: true,
  command: false,
  http: false,
  mcpTool: false,
  file: false,
  log: true,
  humanTask: true,
  subworkflow: true,
  ai: false,
  llm: false,
  tryCatch: true,
  finally: true,
  loop: true,
  parallel: true,
};

/** 非幂等节点权威集合（幂等键开启时崩溃 → 转人工确认）。 */
const EXPECTED_NON_IDEMPOTENT = ["ai", "command", "file", "http", "llm", "mcpTool"] as const;

describe("builtinNodes 幂等标注审计", () => {
  test("全部 17 个内置节点显式标注 idempotent（boolean 类型，无 undefined/缺失）", () => {
    expect(builtinNodes.length).toBe(Object.keys(EXPECTED_IDEMPOTENT).length);
    for (const def of builtinNodes) {
      expect(typeof def.idempotent, `${def.type} 缺省幂等标注`).toBe("boolean");
    }
  });

  test("注册节点 type 集合与权威映射完全一致（新增节点必须登记）", () => {
    const registered = builtinNodes.map((def) => def.type).sort();
    expect(registered).toEqual(Object.keys(EXPECTED_IDEMPOTENT).sort());
  });

  test("type 无重复注册", () => {
    const types = builtinNodes.map((def) => def.type);
    expect(new Set(types).size).toBe(types.length);
  });

  test("幂等标注值与权威映射逐项一致（变更时暴露需同步）", () => {
    for (const def of builtinNodes) {
      expect(def.idempotent, `${def.type} 幂等标注与权威映射漂移`).toBe(EXPECTED_IDEMPOTENT[def.type]);
    }
  });

  test("非幂等节点集合精确匹配（6 个 false，其余 11 个 true）", () => {
    const actual = builtinNodes
      .filter((def) => def.idempotent === false)
      .map((def) => def.type)
      .sort();
    expect(actual).toEqual([...EXPECTED_NON_IDEMPOTENT].sort());
    expect(builtinNodes.filter((def) => def.idempotent !== false)).toHaveLength(11);
  });
});

describe("shouldCrashConfirm 决策语义", () => {
  test("非幂等 + idempotencyKey → true", () => {
    expect(shouldCrashConfirm("req-1", false)).toBe(true);
  });

  test("幂等节点 + idempotencyKey → false", () => {
    expect(shouldCrashConfirm("req-2", true)).toBe(false);
  });

  test("非幂等节点但 key 缺失 → false", () => {
    expect(shouldCrashConfirm(undefined, false)).toBe(false);
  });

  test("幂等节点且 key 缺失 → false", () => {
    expect(shouldCrashConfirm(undefined, true)).toBe(false);
  });

  test("builtinNodes 全链路：开启 key 时仅非幂等节点判定转人工", () => {
    for (const def of builtinNodes) {
      expect(shouldCrashConfirm("audit-key", def.idempotent), `${def.type} 崩溃确认判定与幂等标注不一致`).toBe(def.idempotent === false);
    }
  });
});
