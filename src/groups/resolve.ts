// 功能组依赖解析引擎（v0.3.0 T4）：设计时静态分析（§3.3.2 阶段一）。
// 收集 capabilityGroups 声明 → 版本校验 → dependencies 展开 → 去重 → 循环检测。声明版本锁定；依赖范围匹配目标组 currentVersion；循环抛 GroupResolveError（完整路径 A→B→C→A）。
import { scanGroups, loadVersion } from "./load.js";
import { compareSemVer, parseSemVer } from "./semver.js";
import { GroupResolveError } from "./errors.js";
import type { CapabilityGroup } from "./types.js";
import type { Workflow } from "../model/types.js";

/** 工作流依赖解析结果：resolvedGroups 为去重排序后的 "guid@version" 列表；cycles 恒为空（循环时抛错暴露）。 */
export interface ResolveResult {
  readonly resolvedGroups: string[];
  readonly resolvedAt: string;
  readonly cycles: string[][];
}

export interface CapabilityGroupDeclaration {
  readonly guid: string;
  readonly version: string;
}

/** 声明收集结果：guid → 声明版本与节点路径（错误定位用）。 */
interface DeclaredGroup {
  readonly version: string;
  readonly path: string;
}

// ---- 版本范围匹配：依赖方声明范围 vs 目标组 currentVersion ----
const RANGE_PART = /^([<>]=?)\s*(\d+\.\d+\.\d+)$/;

/** 判断 version 是否满足范围 range：支持 >=/></=</=x.y.z 及空格组合（最多两段）；其他格式 console.warn 后保守返回 false。 */
export function supportsRange(range: string, version: string): boolean {
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 2) {
    console.warn(`不支持的版本范围格式 "${range}"：仅支持 >=x.y.z、<x.y.z 或组合（如 ">=1.0.0 <2.0.0"）`);
    return false;
  }
  const target = parseSemVer(version);
  return parts.every((part) => {
    const match = RANGE_PART.exec(part);
    const op = match?.[1];
    const raw = match?.[2];
    if (op === undefined || raw === undefined) {
      console.warn(`不支持的版本范围格式 "${range}"：段 "${part}" 非法（仅支持 >=x.y.z、<x.y.z 等比较符）`);
      return false;
    }
    const cmp = compareSemVer(target, parseSemVer(raw));
    if (op === ">=") return cmp >= 0;
    if (op === ">") return cmp > 0;
    if (op === "<=") return cmp <= 0;
    return cmp < 0;
  });
}/** 构建 guid → 直接依赖 guid 列表的依赖图（跨所有版本并集，guid 级粒度）。 */
function buildDependencyGraph(groups: readonly CapabilityGroup[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const group of groups) {
    const deps = new Set<string>();
    for (const version of group.versions) {
      for (const dep of version.content.dependencies ?? []) deps.add(dep.guid);
    }
    graph.set(group.guid, [...deps].sort());
  }
  return graph;
}

/** 环路径规范化：去掉末尾起点并旋转到字典序最小起点，得环的等价键（用于环去重）。 */
function normalizeCycle(cycle: string[]): string {
  const body = cycle.slice(0, -1);
  const first = body[0];
  if (first === undefined) return "";
  let min = first;
  let minIndex = 0;
  for (let index = 1; index < body.length; index++) {
    const candidate = body[index];
    if (candidate !== undefined && candidate.localeCompare(min) < 0) {
      min = candidate;
      minIndex = index;
    }
  }
  return [...body.slice(minIndex), ...body.slice(0, minIndex)].join("\u0000");
}

/** 从 start 出发 DFS 找回到 start 的环路径（含首尾重复的 start，如 ["a","b","c","a"]），无环返回 undefined。 */
function findCycleFrom(start: string, graph: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, number>(); // 1=访问中（栈内） 2=完成
  const stack: string[] = [];
  let found: string[] | undefined;
  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (found !== undefined) return;
      if (next === start) {
        found = [...stack, start];
        return;
      }
      if (state.get(next) === undefined) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  visit(start);
  return found;
}

/** 全图找环：逐节点 findCycleFrom + normalize 去重（每个环仅返回一次）。 */
function findAllCycles(graph: Map<string, string[]>): string[][] {
  const seen = new Set<string>();
  const cycles: string[][] = [];
  for (const node of graph.keys()) {
    const cycle = findCycleFrom(node, graph);
    if (cycle === undefined) continue;
    const key = normalizeCycle(cycle);
    if (!seen.has(key)) {
      seen.add(key);
      cycles.push(cycle);
    }
  }
  return cycles;
}

/** 检测单个功能组是否存在循环依赖（guid 级 DFS），返回完整环路径（如 ["a","b","c","a"]），无环返回 undefined。 */
export async function detectCircularDependency(rootDir: string, guid: string): Promise<string[] | undefined> {
  const groups = await scanGroups(rootDir);
  return findCycleFrom(guid, buildDependencyGraph(groups));
}

/** 全量检测所有功能组的循环依赖，返回所有环路径（每个环仅一次）。 */
export async function detectCircularDependencies(rootDir: string): Promise<string[][]> {
  const groups = await scanGroups(rootDir);
  return findAllCycles(buildDependencyGraph(groups));
}

/** 校验并解析 capabilityGroups 声明数组；非法形状抛含节点路径的 GroupResolveError。 */
function parseCapabilityGroups(raw: unknown, path: string): CapabilityGroupDeclaration[] {
  if (!Array.isArray(raw)) {
    throw new GroupResolveError(
      `节点 ${path} 的 capabilityGroups 声明非法：期望数组，每项为 { guid: string; version: string }`,
    );
  }
  const result: CapabilityGroupDeclaration[] = [];
  for (const item of raw) {
    const index = result.length + 1;
    if (typeof item !== "object" || item === null) {
      throw new GroupResolveError(`节点 ${path} 的 capabilityGroups 声明非法：第 ${index} 项非对象`);
    }
    const guid = (item as Readonly<Record<string, unknown>>)["guid"];
    const version = (item as Readonly<Record<string, unknown>>)["version"];
    if (typeof guid !== "string" || typeof version !== "string") {
      throw new GroupResolveError(`节点 ${path} 的 capabilityGroups 声明非法：第 ${index} 项需包含字符串 guid 与 version`);
    }
    result.push({ guid, version });
  }
  return result;
}

/** 遍历工作流所有节点（含 node.subworkflow 递归嵌套）收集 capabilityGroups 声明；同 guid 版本冲突抛 GroupResolveError。 */
function collectDeclarations(workflow: Workflow): Map<string, DeclaredGroup> {
  const declarations = new Map<string, DeclaredGroup>();
  const stack: Array<{ wf: Workflow; parent: string | undefined }> = [{ wf: workflow, parent: undefined }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    for (const node of entry.wf.nodes) {
      const path =
        entry.parent === undefined ? `${node.id} (${node.name})` : `${entry.parent} → ${node.id} (${node.name})`;
      const raw = node.params["capabilityGroups"];
      if (raw !== undefined) {
        for (const item of parseCapabilityGroups(raw, path)) {
          const existing = declarations.get(item.guid);
          if (existing !== undefined && existing.version !== item.version) {
            throw new GroupResolveError(
              `功能组 ${item.guid} 版本冲突：节点 ${existing.path} 声明 ${existing.version}，节点 ${path} 声明 ${item.version}`,
            );
          }
          declarations.set(item.guid, { version: item.version, path });
        }
      }
      if (node.subworkflow !== undefined) {
        stack.push({ wf: node.subworkflow, parent: path });
      }
    }
  }
  return declarations;
}

/** 解析工作流依赖：收集声明 → 校验版本存在 → 展开 dependencies → 循环检测 → 去重排序输出。 */
export async function resolveWorkflowGroups(rootDir: string, workflow: Workflow): Promise<ResolveResult> {
  const groups = await scanGroups(rootDir);
  const byGuid = new Map(groups.map((group) => [group.guid, group]));

  const declarations = collectDeclarations(workflow);
  for (const [guid, declared] of declarations) {
    const group = byGuid.get(guid);
    if (group === undefined) {
      throw new GroupResolveError(`节点 ${declared.path} 依赖的功能组 ${guid}@${declared.version} 不存在`);
    }
    if (loadVersion(group, declared.version) === undefined) {
      const available = group.versions.map((version) => version.version).join(", ");
      throw new GroupResolveError(
        `节点 ${declared.path} 依赖的功能组 ${guid}@${declared.version} 不存在：可用版本：${available}`,
      );
    }
  }

  const resolved = new Map<string, string>();
  const queue = [...declarations.keys()];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const guid = queue.shift();
    if (guid === undefined) break;
    if (visited.has(guid)) continue;
    visited.add(guid);
    const group = byGuid.get(guid);
    if (group === undefined) continue;
    const version = declarations.get(guid)?.version ?? group.currentVersion;
    resolved.set(guid, version);
    const content = loadVersion(group, version)?.content;
    if (content?.dependencies === undefined) continue;
    for (const dep of content.dependencies) {
      const target = byGuid.get(dep.guid);
      if (target === undefined) {
        throw new GroupResolveError(
          `功能组 ${guid}@${version} 声明依赖 ${dep.guid}（范围 "${dep.versionRange}"），但该功能组不存在`,
        );
      }
      if (!supportsRange(dep.versionRange, target.currentVersion)) {
        throw new GroupResolveError(
          `功能组 ${guid}@${version} 声明依赖 ${dep.guid}，但目标功能组当前版本 ${target.currentVersion} 不满足版本范围 "${dep.versionRange}"`,
        );
      }
      if (!visited.has(dep.guid)) queue.push(dep.guid);
    }
  }

  const graph = buildDependencyGraph(groups);
  const subGraph = new Map<string, string[]>();
  for (const guid of visited) {
    subGraph.set(guid, (graph.get(guid) ?? []).filter((dep) => visited.has(dep)));
  }
  const cycles = findAllCycles(subGraph);
  if (cycles.length > 0) {
    throw new GroupResolveError(
      `检测到功能组循环依赖：${cycles.map((cycle) => cycle.join("→")).join("；")}`,
    );
  }

  const resolvedGroups = Array.from(resolved.entries())
    .map(([guid, version]) => `${guid}@${version}`)
    .sort((a, b) => a.localeCompare(b));
  return { resolvedGroups, resolvedAt: new Date().toISOString(), cycles: [] };
}
