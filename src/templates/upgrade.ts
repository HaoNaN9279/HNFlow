// 模板引用升级（T4）：基于 checkTemplateUpdates 报告，按门槛过滤 + D7 端口校验后更新节点 template 引用版本。
// 纯函数：不写文件（保存由 CLI 层执行）。无升级项时返回原 workflow 引用，避免无谓克隆。
// 参照 src/groups/upgrade.ts（upgradeWorkflow）模式：门槛默认全手动。
import { deepCopyWorkflow } from "../utils/deepCopy.js";
import type { Node, Workflow } from "../model/types.js";
import { scanTemplates } from "./load.js";
import type { WorkflowTemplate } from "./types.js";
import { checkTemplateUpdates, collectTemplateRefs, type VersionDiff } from "./updates.js";

/** 单个模板的升级明细。 */
export interface TemplateUpgradedEntry {
  readonly name: string;
  readonly nodePath: string;
  readonly from: string; // 原锁定版本
  readonly to: string; // 升级到的最新版本
  readonly diff: "major" | "minor" | "patch";
}

/** 升级门槛：默认全手动（patch/minor/major 都需显式允许）。 */
export interface TemplateUpgradeOptions {
  readonly autoPatch?: boolean; // 默认 false：patch 级是否自动升级
  readonly allowMinor?: boolean; // 默认 false
  readonly allowMajor?: boolean; // 默认 false
  readonly ignores?: readonly string[]; // "name@version" 忽略（与 checkTemplateUpdates 一致语义）
}

export interface TemplateUpgradeResult {
  readonly workflow: Workflow; // 无升级时返回原引用
  readonly upgraded: readonly TemplateUpgradedEntry[]; // 实际更新的
  readonly skipped: readonly TemplateUpgradedEntry[]; // 端口不匹配跳过
}

/** 门槛判断：diff 分类对应开关；开关为 true 才放行。 */
function isAllowed(diff: VersionDiff, options: TemplateUpgradeOptions): boolean {
  switch (diff) {
    case "patch":
      return options.autoPatch === true;
    case "minor":
      return options.allowMinor === true;
    case "major":
      return options.allowMajor === true;
  }
}

/**
 * D7 端口校验：引用模板的父节点端口须与最新版本模板 interface 匹配。
 * - 输入：interface.inputs 中每个参数 p，父节点 inputs 需存在 id "in_"+p 的端口；
 * - 输出：父节点 outputs 中每个 "out_"+x 端口（排除固定 "out"），x 需在 interface.outputs 中。
 * 任一不满足返回 false（该模板计入 skipped，不更新）。
 */
function interfaceMatches(node: Node, template: WorkflowTemplate): boolean {
  const inputIds = new Set(node.inputs.map((port) => port.id));
  for (const param of template.interface.inputs) {
    if (!inputIds.has(`in_${param}`)) return false;
  }
  const outputNames = new Set(template.interface.outputs);
  for (const port of node.outputs) {
    if (port.id === "out") continue; // 固定输出端口不参与校验
    if (!port.id.startsWith("out_")) continue; // 非自动输出端口：防御不校验
    const key = port.id.slice("out_".length);
    if (!outputNames.has(key)) return false;
  }
  return true;
}

/** 递归遍历节点数组，按节点路径精确更新模板引用为 "name@latest"；重建节点保持不可变风格。 */
function upgradeNodes(
  nodes: readonly Node[],
  parent: string | undefined,
  upgradeByPath: ReadonlyMap<string, string>,
): Node[] {
  return nodes.map((node) => {
    const path =
      parent === undefined ? `${node.id} (${node.name})` : `${parent} → ${node.id} (${node.name})`;
    const raw = node.params["template"];
    let params = node.params;
    if (typeof raw === "string") {
      const target = upgradeByPath.get(path);
      if (target !== undefined) {
        params = { ...params, template: target };
      }
    }
    const subworkflow =
      node.subworkflow === undefined
        ? undefined
        : { ...node.subworkflow, nodes: upgradeNodes(node.subworkflow.nodes, path, upgradeByPath) };
    return { ...node, params, ...(subworkflow === undefined ? {} : { subworkflow }) };
  });
}

/**
 * 升级工作流中模板引用版本到最新。
 * - 先调 checkTemplateUpdates 获取可升级项（ignores 语义透传）；
 * - 门槛过滤：patch 需 autoPatch、minor 需 allowMinor、major 需 allowMajor，不满足不升级；
 * - D7 端口校验：门槛通过的项校验最新版本模板 interface 与父节点端口，不匹配计入 skipped 不更新；
 * - 无任何升级 → 返回原 workflow 引用；
 * - 有升级 → 深克隆 → 按节点路径更新引用。
 */
export async function upgradeTemplateRefs(
  rootDir: string,
  workflow: Workflow,
  options?: TemplateUpgradeOptions,
): Promise<TemplateUpgradeResult> {
  const opts: TemplateUpgradeOptions = options ?? {};
  const report = await checkTemplateUpdates(
    rootDir,
    workflow,
    opts.ignores === undefined ? {} : { ignores: opts.ignores },
  );
  const allowed = report.entries.filter((entry) => isAllowed(entry.diff, opts));
  if (allowed.length === 0) {
    return { workflow, upgraded: [], skipped: [] };
  }

  // 收集引用（含节点引用用于端口校验），按 nodePath 索引。
  const refs = collectTemplateRefs(workflow);
  const refByPath = new Map(refs.map((ref) => [ref.path, ref]));

  const templates = await scanTemplates(rootDir);
  const byName = new Map<string, WorkflowTemplate>(templates.map((template) => [template.name, template]));

  const upgraded: TemplateUpgradedEntry[] = [];
  const skipped: TemplateUpgradedEntry[] = [];
  const upgradeByPath = new Map<string, string>();

  for (const entry of allowed) {
    const ref = refByPath.get(entry.nodePath);
    const template = byName.get(entry.name);
    if (ref === undefined || template === undefined) continue; // 防御：引用已不存在

    const detail: TemplateUpgradedEntry = {
      name: entry.name,
      nodePath: entry.nodePath,
      from: entry.lockedVersion,
      to: entry.latestVersion,
      diff: entry.diff,
    };

    // D7 端口校验：基准为最新版本模板 interface（byName 中即当前版本）。
    if (!interfaceMatches(ref.node, template)) {
      skipped.push(detail);
      continue;
    }

    upgraded.push(detail);
    upgradeByPath.set(entry.nodePath, `${entry.name}@${entry.latestVersion}`);
  }

  if (upgraded.length === 0) {
    return { workflow, upgraded: [], skipped };
  }

  const cloned = deepCopyWorkflow(workflow);
  const upgradedWorkflow: Workflow = { ...cloned, nodes: upgradeNodes(cloned.nodes, undefined, upgradeByPath) };
  return { workflow: upgradedWorkflow, upgraded, skipped };
}
