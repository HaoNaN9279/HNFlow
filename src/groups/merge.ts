// 多功能组合并引擎（v0.3.1 T2）：合并多个 LoadedGroupContent → MergedGroups。
// D1-D6 决策：agent 优先级 / 工具命名空间前缀 / rules 排序+互斥检测 / mcps 优先级覆盖。
// 纯函数：不修改入参，返回全新对象（数组重新生成，parameters/config 浅拷贝）。
import type { LoadedGroupContent, LoadedRule } from "./content-loader.js";

/** 规则互斥冲突：两个规则要求不同的 constraint。 */
export interface GroupMergeConflict {
  readonly rulePathA: string;
  readonly rulePathB: string;
  readonly constraintA: string;
  readonly constraintB: string;
}

/** 合并后的功能组工具（已加命名空间前缀）。 */
export interface MergedTool {
  readonly fullName: string; // 已加前缀："web/scraping/playwright.read_file" 或原名（namespace 无时）
  readonly namespace: string;
  readonly baseName: string; // 原始工具名
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly sourceGuid: string;
  readonly sourceVersion: string;
}

/** 合并后的规则（已按加载顺序+order 排序）。 */
export interface MergedRule {
  readonly path: string;
  readonly order: number;
  readonly text: string;
  readonly constraint?: string;
  readonly sourceNamespace: string;
  readonly sourceGuid: string;
}

/** 合并后的 MCP 配置。 */
export interface MergedMcp {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly sourceGuid: string;
}

/** 多功能组合并结果。 */
export interface MergedGroups {
  /** 生效的 agent 身份文本：加载顺序中第一个有 agent 的组；无则 undefined。 */
  readonly agent?: { readonly text: string; readonly sourceGuid: string; readonly sourceNamespace: string };
  /** 补充 agent 文本（其余组的 agent 转为补充规则）。 */
  readonly supplementaryAgents: readonly { readonly text: string; readonly sourceGuid: string; readonly sourceNamespace: string }[];
  readonly tools: readonly MergedTool[];
  readonly rules: readonly MergedRule[];
  readonly mcps: readonly MergedMcp[];
  /** 互斥规则冲突（仅检测，不阻断）。 */
  readonly conflicts: readonly GroupMergeConflict[];
}

/** 命名空间前缀拼接：对齐 ai/tool.ts applyNamespace 语义（namespace 为空返回原名），merge 层独立实现不依赖 ai 层。 */
function applyNamespace(name: string, namespace: string): string {
  if (namespace === "") {
    return name;
  }
  return `${namespace}.${name}`;
}

/** 排序中间记录：规则 + 所属组索引（排序键，先索引后 order）。 */
interface IndexedRule {
  readonly groupIndex: number;
  readonly rule: LoadedRule;
  readonly content: LoadedGroupContent;
}

/** 规则转 MergedRule：可选 constraint 仅在存在时写出（exactOptionalPropertyTypes 惯例同 content-loader）。 */
function toMergedRule(entry: IndexedRule): MergedRule {
  const { rule, content } = entry;
  return {
    path: rule.path,
    order: rule.order,
    text: rule.text,
    ...(rule.constraint !== undefined ? { constraint: rule.constraint } : {}),
    sourceNamespace: content.namespace,
    sourceGuid: content.guid,
  };
}

/** 合并多个功能组内容。contents 数组顺序即加载顺序（数组靠前优先）；返回新对象，不修改入参。 */
export function mergeGroups(contents: readonly LoadedGroupContent[]): MergedGroups {
  // agent：第一个有 agent 的组生效（activeAgent）；其余组的 agent 全部进 supplementaryAgents。
  let activeAgent: { readonly text: string; readonly sourceGuid: string; readonly sourceNamespace: string } | undefined;
  const supplementaryAgents: { readonly text: string; readonly sourceGuid: string; readonly sourceNamespace: string }[] = [];
  for (const content of contents) {
    if (content.agent === undefined) {
      continue;
    }
    const entry = { text: content.agent.text, sourceGuid: content.guid, sourceNamespace: content.namespace };
    if (activeAgent === undefined) {
      activeAgent = entry;
    } else {
      supplementaryAgents.push(entry);
    }
  }

  // tools：全部合并，fullName 加命名空间前缀（namespace 为空时用原名，"/" 保留原样）。
  const tools: MergedTool[] = [];
  for (const content of contents) {
    for (const tool of content.tools) {
      tools.push({
        fullName: applyNamespace(tool.name, content.namespace),
        namespace: content.namespace,
        baseName: tool.name,
        description: tool.description,
        parameters: { ...tool.parameters },
        sourceGuid: content.guid,
        sourceVersion: content.version,
      });
    }
  }

  // rules：按组加载顺序（contents 索引）+ 组内 order 排序（先按索引，再按 order）。
  const indexedRules: IndexedRule[] = [];
  contents.forEach((content, groupIndex) => {
    for (const rule of content.rules) {
      indexedRules.push({ groupIndex, rule, content });
    }
  });
  indexedRules.sort((a, b) => a.groupIndex - b.groupIndex || a.rule.order - b.rule.order);
  const rules = indexedRules.map(toMergedRule);

  // rules 互斥检测：同一对规则（i<j）只检测一次，天然去重；非空且不同才冲突。
  const conflicts: GroupMergeConflict[] = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const constraintA = a.constraint;
      const constraintB = b.constraint;
      if (constraintA !== undefined && constraintB !== undefined && constraintA !== constraintB) {
        conflicts.push({ rulePathA: a.path, rulePathB: b.path, constraintA, constraintB });
      }
    }
  }

  // mcps：同名 name 靠前（优先级高）覆盖靠后，只保留第一个。
  const seenMcpNames = new Set<string>();
  const mcps: MergedMcp[] = [];
  for (const content of contents) {
    for (const mcp of content.mcps) {
      if (seenMcpNames.has(mcp.name)) {
        continue;
      }
      seenMcpNames.add(mcp.name);
      mcps.push({ name: mcp.name, config: { ...mcp.config }, sourceGuid: content.guid });
    }
  }

  return {
    ...(activeAgent !== undefined ? { agent: activeAgent } : {}),
    supplementaryAgents,
    tools,
    rules,
    mcps,
    conflicts,
  };
}
