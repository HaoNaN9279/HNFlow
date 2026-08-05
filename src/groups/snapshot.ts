// 功能组快照有效期校验与级联刷新（v0.3.0 T6）。
// 设计蓝图 §3.3.2 阶段一：快照过期（生成时间 < group.json 最后修改时间）→ 标记过期，禁止保存；一键级联更新所有依赖快照。
// 本模块只提供能力；保存钩子（T5/T7）负责在过期时拦截保存并触发刷新。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findGroupByGuid } from "./load.js";
import { resolveWorkflowGroups } from "./resolve.js";
import type { Workflow } from "../model/types.js";

/** 过期功能组明细：guid/namespace 用于定位；mtimeMs 为 group.json 修改时间（缺文件时占位 0）。 */
export interface ExpiredGroupInfo {
  readonly guid: string;
  readonly namespace: string;
  readonly mtimeMs: number;
}

/** 快照新鲜度：fresh=false 时 expiredGroups 列出全部过期功能组。 */
export interface SnapshotStatus {
  readonly fresh: boolean;
  readonly expiredGroups: readonly ExpiredGroupInfo[];
}

/**
 * T5 将把 resolvedGroups/resolvedAt 并入 Workflow 类型；本模块以交叉契约只读访问，
 * 字段并入后自动退化（向前兼容，遵守 readonly 契约）。
 */
export interface ResolvedSnapshotFields {
  readonly resolvedGroups?: readonly string[];
  readonly resolvedAt?: string;
}

/** 携带解析快照字段的工作流视图：既是 Workflow，又含 T5 将并入的快照字段。 */
export type SnapshotWorkflow = Workflow & ResolvedSnapshotFields;

/** ISO 8601 时间戳（resolve.ts 生成 "YYYY-MM-DDTHH:mm:ss.sssZ"）；非 ISO 一律视为非法。 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 从 "guid@version" 解析 guid：取首个 "@" 之前部分（guid 为 UUID 不含 "@"；畸形条目防御性原样返回）。 */
function parseGuidFromEntry(entry: string): string {
  const at = entry.indexOf("@");
  return at === -1 ? entry : entry.slice(0, at);
}

/** 功能组 group.json 路径 = <namespace 目录>/group.json。 */
function groupJsonPath(rootDir: string, namespace: string): string {
  return join(rootDir, ...namespace.split("/"), "group.json");
}

/**
 * 校验工作流快照新鲜度：
 * - 无 resolvedGroups/resolvedAt → fresh（无快照无需校验；保存路径会先 resolve 生成快照）；
 * - resolvedAt 非 ISO → 视为过期（保守：无法确定生成时间基准）；
 * - 每个 guid 取 group.json 的 mtimeMs，mtimeMs > resolvedAt（生成时间 < 修改时间）→ 过期；
 * - guid 在 rootDir 找不到或 group.json 缺失 → 视为过期（缺依赖文件不可信；T5 保存时 resolve 会先拦截）。
 */
export async function checkSnapshotFresh(rootDir: string, workflow: Workflow): Promise<SnapshotStatus> {
  const snap = workflow as SnapshotWorkflow;
  if (snap.resolvedGroups === undefined || snap.resolvedAt === undefined) {
    return { fresh: true, expiredGroups: [] };
  }
  const resolvedAtMs = Date.parse(snap.resolvedAt);
  if (!ISO_TIMESTAMP.test(snap.resolvedAt) || Number.isNaN(resolvedAtMs)) {
    return { fresh: false, expiredGroups: [] };
  }
  const expired: ExpiredGroupInfo[] = [];
  for (const entry of snap.resolvedGroups) {
    const guid = parseGuidFromEntry(entry);
    const group = await findGroupByGuid(rootDir, guid);
    if (group === undefined) {
      expired.push({ guid, namespace: "", mtimeMs: 0 }); // 缺组：namespace/mtimeMs 无意义，占位
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(groupJsonPath(rootDir, group.namespace))).mtimeMs;
    } catch {
      expired.push({ guid, namespace: group.namespace, mtimeMs: 0 }); // group.json 缺失/不可读，同缺组语义
      continue;
    }
    if (mtimeMs > resolvedAtMs) {
      expired.push({ guid, namespace: group.namespace, mtimeMs });
    }
  }
  return { fresh: expired.length === 0, expiredGroups: expired };
}

/**
 * 级联刷新快照：调 resolveWorkflowGroups 重新解析，返回带新 resolvedGroups/resolvedAt 的新 Workflow 对象（不改入参）。
 * 级联语义（v0.3.0 简化）：一次完整 resolve 即从最底层依赖向上重算全部快照
 * （内嵌 subworkflow 递归由 resolveWorkflowGroups 的 collectDeclarations 处理）。
 * 将来 v0.3.2 子工作流模板独立文件时，再按层级增量刷新。
 */
export async function refreshSnapshot(rootDir: string, workflow: Workflow): Promise<SnapshotWorkflow> {
  const result = await resolveWorkflowGroups(rootDir, workflow);
  return { ...workflow, resolvedGroups: result.resolvedGroups, resolvedAt: result.resolvedAt };
}
