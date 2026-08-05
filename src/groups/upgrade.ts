// 功能组版本升级（v0.3.2 T2）：基于 checkGroupUpdates 报告，按门槛过滤后更新节点声明版本并刷新依赖快照。
// 纯函数：不写文件（保存由 CLI 层执行）。无升级项时返回原 workflow 引用，避免无谓克隆。
import { deepCopyWorkflow } from "../utils/deepCopy.js";
import type { Node, Workflow } from "../model/types.js";
import { resolveWorkflowGroups } from "./resolve.js";
import { checkGroupUpdates, type GroupUpdateEntry } from "./updates.js";

/** 单个功能组的升级明细。 */
export interface UpgradedEntry {
  readonly guid: string;
  readonly namespace: string;
  readonly from: string; // 原锁定版本
  readonly to: string;   // 升级到的最新版本
  readonly diff: "major" | "minor" | "patch";
}

/** 升级门槛：默认全手动（patch/minor/major 都需显式允许）。 */
export interface UpgradeOptions {
  readonly autoPatch?: boolean;     // 默认 false：patch 级是否自动升级
  readonly allowMinor?: boolean;    // 默认 false
  readonly allowMajor?: boolean;    // 默认 false
  readonly ignores?: readonly string[]; // "guid@version" 忽略（与 checkGroupUpdates 一致语义）
}

export interface UpgradeResult {
  readonly workflow: Workflow;      // 新 Workflow（声明已更新 + 快照已刷新）
  readonly upgraded: readonly UpgradedEntry[];
}

/** 门槛判断：diff 分类对应开关；开关为 true 才放行。 */
function isAllowed(entry: GroupUpdateEntry, options: UpgradeOptions): boolean {
  switch (entry.diff) {
    case "patch":
      return options.autoPatch === true;
    case "minor":
      return options.allowMinor === true;
    case "major":
      return options.allowMajor === true;
  }
}

/** 递归遍历节点数组，对 capabilityGroups 声明中 guid 匹配可升级项的条目更新 version；重建节点保持不可变风格。 */
function upgradeNodes(nodes: readonly Node[], latestByGuid: ReadonlyMap<string, string>): Node[] {
  return nodes.map((node) => {
    const raw = node.params["capabilityGroups"];
    let params = node.params;
    if (Array.isArray(raw)) {
      let changed = false;
      const updated = raw.map((item) => {
        if (typeof item !== "object" || item === null) return item;
        const record = item as Readonly<Record<string, unknown>>;
        const guid = record["guid"];
        if (typeof guid !== "string") return item;
        const latest = latestByGuid.get(guid);
        if (latest === undefined) return item;
        changed = true;
        return { ...record, version: latest };
      });
      if (changed) params = { ...params, capabilityGroups: updated };
    }
    const subworkflow =
      node.subworkflow === undefined
        ? undefined
        : { ...node.subworkflow, nodes: upgradeNodes(node.subworkflow.nodes, latestByGuid) };
    return { ...node, params, ...(subworkflow === undefined ? {} : { subworkflow }) };
  });
}

/**
 * 升级工作流中 capabilityGroups 声明版本到最新。
 * - 先调 checkGroupUpdates 获取可升级项（ignores 语义透传）；
 * - 门槛过滤：patch 需 autoPatch、minor 需 allowMinor、major 需 allowMajor，不满足不升级；
 * - 无任何升级 → 返回原 workflow 引用 + 空明细；
 * - 有升级 → 深克隆 → 更新全部节点（含 subworkflow）声明 → resolveWorkflowGroups 刷新快照写入新对象。
 */
export async function upgradeWorkflow(
  rootDir: string,
  workflow: Workflow,
  options?: UpgradeOptions,
): Promise<UpgradeResult> {
  const opts: UpgradeOptions = options ?? {};
  const report = await checkGroupUpdates(
    rootDir,
    workflow,
    opts.ignores === undefined ? {} : { ignores: opts.ignores },
  );
  const allowed = report.entries.filter((entry) => isAllowed(entry, opts));
  if (allowed.length === 0) {
    return { workflow, upgraded: [] };
  }

  const latestByGuid = new Map(allowed.map((entry) => [entry.guid, entry.latestVersion]));
  const cloned = deepCopyWorkflow(workflow);
  const upgradedWorkflow: Workflow = { ...cloned, nodes: upgradeNodes(cloned.nodes, latestByGuid) };

  // 刷新依赖快照：声明已更新，重新解析生成最新 resolvedGroups / resolvedAt。
  const resolved = await resolveWorkflowGroups(rootDir, upgradedWorkflow);
  const newWorkflow: Workflow = {
    ...upgradedWorkflow,
    resolvedGroups: resolved.resolvedGroups,
    resolvedAt: resolved.resolvedAt,
  };

  const upgraded: UpgradedEntry[] = allowed.map((entry) => ({
    guid: entry.guid,
    namespace: entry.namespace,
    from: entry.lockedVersion,
    to: entry.latestVersion,
    diff: entry.diff,
  }));
  return { workflow: newWorkflow, upgraded };
}
