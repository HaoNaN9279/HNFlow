// 功能组兼容性校验（v0.3.2 T3）：纯函数比对功能组前后两个版本内容，生成版本兼容性报告。
// 工具删除 → breaking；工具新增 / parameters 变化 / 规则变化 / MCP 变化 / agent 变化 → minor；description 变化 → patch。
// 顺序无关：tool/rule/mcp 按 name/path 匹配；parameters/config 用 canonical JSON（sorted keys）消除顺序噪声。
import type { LoadedGroupContent, LoadedMcp, LoadedRule, LoadedTool } from "./content-loader.js";

/** 单个变更条目。 */
export interface CompatChange {
  readonly kind: string; // 如 "tool_removed" / "tool_added" / "tool_parameters_changed" / "tool_description_changed" / "rule_changed" / "mcp_changed" / "agent_changed"
  readonly detail: string; // 人类可读中文描述，含资源名
}

/** 兼容性级别（升级建议级别）。 */
export type CompatibilityLevel = "breaking" | "minor" | "patch" | "compatible";

export interface CompatibilityReport {
  readonly changes: readonly CompatChange[];
  readonly level: CompatibilityLevel; // 任一 breaking → breaking；否则任一 minor → minor；否则任一 patch → patch；无变化 → compatible
}

const BREAKING_KINDS = new Set(["tool_removed"]);
const MINOR_KINDS = new Set(["tool_added", "tool_parameters_changed", "rule_changed", "mcp_changed", "agent_changed"]);

/**
 * canonical JSON 序列化：递归，对象按 key 排序（localeCompare），数组保序，其他类型 JSON.stringify。
 * 用于 parameters/config 比较，消除对象 key 顺序噪声。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function resolveLevel(changes: readonly CompatChange[]): CompatibilityLevel {
  if (changes.some((change) => BREAKING_KINDS.has(change.kind))) {
    return "breaking";
  }
  if (changes.some((change) => MINOR_KINDS.has(change.kind))) {
    return "minor";
  }
  if (changes.length > 0) {
    return "patch";
  }
  return "compatible";
}

/** 工具差异：按 name 匹配。删除 → breaking；新增 / parameters 变化 → minor；description 变化 → patch（parameters 也变时只记 parameters）。 */
function collectToolChanges(prevTools: readonly LoadedTool[], nextTools: readonly LoadedTool[], changes: CompatChange[]): void {
  const prevByName = new Map(prevTools.map((tool) => [tool.name, tool]));
  const nextByName = new Map(nextTools.map((tool) => [tool.name, tool]));
  for (const [name, prevTool] of prevByName) {
    const nextTool = nextByName.get(name);
    if (nextTool === undefined) {
      changes.push({ kind: "tool_removed", detail: `工具 ${name} 已删除` });
      continue;
    }
    if (canonicalJson(prevTool.parameters) !== canonicalJson(nextTool.parameters)) {
      changes.push({ kind: "tool_parameters_changed", detail: `工具 ${name} 参数已变化` });
    } else if (prevTool.description !== nextTool.description) {
      changes.push({ kind: "tool_description_changed", detail: `工具 ${name} 描述已变化` });
    }
  }
  for (const [name] of nextByName) {
    if (!prevByName.has(name)) {
      changes.push({ kind: "tool_added", detail: `新增工具 ${name}` });
    }
  }
}

/** 规则差异：按 path 匹配，text/order/constraint 任一变化或增删 → minor（顺序无关）。 */
function collectRuleChanges(prevRules: readonly LoadedRule[], nextRules: readonly LoadedRule[], changes: CompatChange[]): void {
  const prevByPath = new Map(prevRules.map((rule) => [rule.path, rule]));
  const nextByPath = new Map(nextRules.map((rule) => [rule.path, rule]));
  for (const [path, prevRule] of prevByPath) {
    const nextRule = nextByPath.get(path);
    if (nextRule === undefined) {
      changes.push({ kind: "rule_changed", detail: `规则 ${path} 已删除` });
      continue;
    }
    if (prevRule.text !== nextRule.text || prevRule.order !== nextRule.order || prevRule.constraint !== nextRule.constraint) {
      changes.push({ kind: "rule_changed", detail: `规则 ${path} 已变化` });
    }
  }
  for (const [path] of nextByPath) {
    if (!prevByPath.has(path)) {
      changes.push({ kind: "rule_changed", detail: `新增规则 ${path}` });
    }
  }
}

/** MCP 差异：按 name 匹配，config 变化或增删 → minor（顺序无关）。 */
function collectMcpChanges(prevMcps: readonly LoadedMcp[], nextMcps: readonly LoadedMcp[], changes: CompatChange[]): void {
  const prevByName = new Map(prevMcps.map((mcp) => [mcp.name, mcp]));
  const nextByName = new Map(nextMcps.map((mcp) => [mcp.name, mcp]));
  for (const [name, prevMcp] of prevByName) {
    const nextMcp = nextByName.get(name);
    if (nextMcp === undefined) {
      changes.push({ kind: "mcp_changed", detail: `MCP ${name} 已删除` });
      continue;
    }
    if (canonicalJson(prevMcp.config) !== canonicalJson(nextMcp.config)) {
      changes.push({ kind: "mcp_changed", detail: `MCP ${name} 配置已变化` });
    }
  }
  for (const [name] of nextByName) {
    if (!prevByName.has(name)) {
      changes.push({ kind: "mcp_changed", detail: `新增 MCP ${name}` });
    }
  }
}

/** 比对功能组前后两个版本内容，生成兼容性报告。prev 为 undefined（无上一版本可比）→ compatible。 */
export function checkCompatibility(prev: LoadedGroupContent | undefined, next: LoadedGroupContent): CompatibilityReport {
  if (prev === undefined) {
    return { changes: [], level: "compatible" };
  }
  const changes: CompatChange[] = [];
  collectToolChanges(prev.tools, next.tools, changes);
  collectRuleChanges(prev.rules, next.rules, changes);
  collectMcpChanges(prev.mcps, next.mcps, changes);
  if (prev.agent?.text !== next.agent?.text) {
    changes.push({ kind: "agent_changed", detail: "agent 已变化" });
  }
  return { changes, level: resolveLevel(changes) };
}
