// 模板升级端口映射（纯逻辑模块）
// 场景：subworkflow 节点锁定模板版本，模板升级后 interface 可能增删参数。
// 本模块对比当前节点端口与目标模板 interface，产出映射计划（buildUpgradePlan），
// 再按手动映射选择执行端口重建/断开（applyUpgradePlan）。全程纯函数，不修改输入。
// 端口规则：输入端口 id = "in_<key>"（key 为 interface.inputs 参数名），
// 输出端口 id = "out_<x>"（x 为 interface.outputs 输出变量名）+ 固定输出端口 "out"（恒存在，不参与映射）。
import type { Edge, Node, Port } from "../model/types.js";
import type { TemplateInterface } from "./types.js";

const INPUT_PREFIX = "in_";
const OUTPUT_PREFIX = "out_";
const FIXED_OUTPUT_ID = "out";

/** 单个当前端口的映射记录：同名自动匹配或目标已移除需手动处理。 */
export interface PortMapping {
  readonly kind: "input" | "output";
  readonly currentKey: string; // 去 in_/out_ 前缀的当前端口 key
  readonly matchedKey: string | undefined; // 自动匹配的目标 key；待手动处理为 undefined
  readonly auto: boolean; // 是否为同名自动匹配
  readonly hasEdge: boolean; // 该端口当前是否有关联边
  readonly edgeIds: readonly string[]; // 该端口关联边 id（精确断开用）
}

/** 升级映射计划：buildUpgradePlan 的纯数据产物。 */
export interface UpgradePlan {
  readonly mappings: readonly PortMapping[];
  readonly autoMatched: readonly PortMapping[];
  readonly manual: readonly PortMapping[];
  readonly addedKeys: readonly { readonly kind: "input" | "output"; readonly key: string }[];
  readonly edgeIdsToDisconnect: readonly string[];
}

/** buildUpgradePlan 入参。 */
export interface BuildUpgradePlanInput {
  readonly node: Node; // type === "subworkflow" 的节点
  readonly targetInterface: TemplateInterface;
  readonly edges: readonly Edge[]; // 与 node 端口关联的边
}

/** applyUpgradePlan 结果：新节点 + 需移除边 + 断开端口 key。 */
export interface ApplyUpgradeResult {
  readonly node: Node;
  readonly edgesToRemove: readonly string[];
  readonly manualDisconnected: readonly string[]; // 选择断开（未映射）的 manual 端口 key
}

/** applyUpgradePlan 入参。 */
export interface ApplyUpgradeInput {
  readonly node: Node;
  readonly plan: UpgradePlan;
  readonly templateName: string;
  readonly targetVersion: string;
  readonly manualMappings: Readonly<Record<string, string>>; // manual 端口 key → 目标 key；缺省视为断开
}

/** 输入端口 key：去 in_ 前缀；非 in_ 前缀端口返回 undefined（防御跳过）。 */
function inputKeyOf(portId: string): string | undefined {
  return portId.startsWith(INPUT_PREFIX) ? portId.slice(INPUT_PREFIX.length) : undefined;
}

/** 输出端口 key：去 out_ 前缀；非 out_ 前缀端口返回 undefined（防御跳过）。 */
function outputKeyOf(portId: string): string | undefined {
  return portId.startsWith(OUTPUT_PREFIX) ? portId.slice(OUTPUT_PREFIX.length) : undefined;
}

/** 与指定端口关联的边 id：输入端口看 target 端，输出端口看 source 端。 */
function relatedEdgeIds(
  nodeId: string,
  portId: string,
  direction: "in" | "out",
  edges: readonly Edge[],
): readonly string[] {
  return edges
    .filter((edge) =>
      direction === "in"
        ? edge.targetNodeId === nodeId && edge.targetPortId === portId
        : edge.sourceNodeId === nodeId && edge.sourcePortId === portId,
    )
    .map((edge) => edge.id);
}

/**
 * 生成升级映射计划：对比 node 端口与目标模板 interface。
 * - 输入端口 in_<key>：key 存在于 interface.inputs → 同名自动匹配；否则 manual。
 * - 输出端口 out_<x>（排除固定 "out"）：x 存在于 interface.outputs → 同名自动匹配；否则 manual。
 * - addedKeys：目标有、当前没有的 key（输入/输出分别按 interface 顺序）。
 * - edgeIdsToDisconnect：全部 manual 且有关联边的端口边 id（断开候选，扁平）。
 */
export function buildUpgradePlan(input: BuildUpgradePlanInput): UpgradePlan {
  const { node, targetInterface, edges } = input;
  const targetInputs = new Set(targetInterface.inputs);
  const targetOutputs = new Set(targetInterface.outputs);

  const mappings: PortMapping[] = [];
  const disconnectCandidates: string[] = [];

  for (const port of node.inputs) {
    const key = inputKeyOf(port.id);
    if (key === undefined) continue;
    const edgeIds = relatedEdgeIds(node.id, port.id, "in", edges);
    const auto = targetInputs.has(key);
    mappings.push({
      kind: "input",
      currentKey: key,
      matchedKey: auto ? key : undefined,
      auto,
      hasEdge: edgeIds.length > 0,
      edgeIds,
    });
    if (!auto && edgeIds.length > 0) disconnectCandidates.push(...edgeIds);
  }

  for (const port of node.outputs) {
    if (port.id === FIXED_OUTPUT_ID) continue; // 固定输出端口不参与映射
    const key = outputKeyOf(port.id);
    if (key === undefined) continue;
    const edgeIds = relatedEdgeIds(node.id, port.id, "out", edges);
    const auto = targetOutputs.has(key);
    mappings.push({
      kind: "output",
      currentKey: key,
      matchedKey: auto ? key : undefined,
      auto,
      hasEdge: edgeIds.length > 0,
      edgeIds,
    });
    if (!auto && edgeIds.length > 0) disconnectCandidates.push(...edgeIds);
  }

  // addedKeys：目标有、当前没有的 key（按 interface 顺序）。
  const currentInputs = new Set(
    node.inputs.map((port) => inputKeyOf(port.id)).filter((key): key is string => key !== undefined),
  );
  const currentOutputs = new Set(
    node.outputs
      .filter((port) => port.id !== FIXED_OUTPUT_ID)
      .map((port) => outputKeyOf(port.id))
      .filter((key): key is string => key !== undefined),
  );
  const addedKeys: { kind: "input" | "output"; key: string }[] = [];
  for (const key of targetInterface.inputs) {
    if (!currentInputs.has(key)) addedKeys.push({ kind: "input", key });
  }
  for (const key of targetInterface.outputs) {
    if (!currentOutputs.has(key)) addedKeys.push({ kind: "output", key });
  }

  return {
    mappings,
    autoMatched: mappings.filter((mapping) => mapping.auto),
    manual: mappings.filter((mapping) => !mapping.auto),
    addedKeys,
    edgeIdsToDisconnect: disconnectCandidates,
  };
}

/** 构造输入端口（type 恒 "any"，方向恒 "in"）。 */
function makeInPort(key: string): Port {
  return { id: `${INPUT_PREFIX}${key}`, name: key, type: "any", direction: "in" };
}

/** 构造输出端口（type 恒 "any"，方向恒 "out"）。 */
function makeOutPort(key: string): Port {
  return { id: `${OUTPUT_PREFIX}${key}`, name: key, type: "any", direction: "out" };
}

/** 固定输出端口：id 恒 "out"，name/type 沿用当前节点同 id 端口，找不到用默认值。 */
function fixedOutPort(node: Node): Port {
  const existing = node.outputs.find((port) => port.id === FIXED_OUTPUT_ID);
  return {
    id: FIXED_OUTPUT_ID,
    name: existing === undefined ? FIXED_OUTPUT_ID : existing.name,
    type: existing === undefined ? "any" : existing.type,
    direction: "out",
  };
}

/**
 * 执行升级：按计划重建节点端口并更新模板引用版本。
 * - 端口重建：mappings 中 auto → 同名；manual 有映射 → 映射目标 key；manual 无映射 → 断开删除；
 *   addedKeys → 新增端口；固定 "out" 输出端口恒保留（沿用 name/type）。
 * - 断开：未映射 manual 端口的关联边进 edgesToRemove，key 进 manualDisconnected。
 * - params.template = `${templateName}@${targetVersion}`；id/type/name/position/subworkflow 不变。
 */
export function applyUpgradePlan(input: ApplyUpgradeInput): ApplyUpgradeResult {
  const { node, plan, templateName, targetVersion, manualMappings } = input;

  // 防御：manual 映射目标可能与 auto/added 端口重合，按 id 去重避免重复端口。
  const inputs: Port[] = [];
  const seenInputIds = new Set<string>();
  const pushInput = (port: Port): void => {
    if (seenInputIds.has(port.id)) return;
    seenInputIds.add(port.id);
    inputs.push(port);
  };
  const outputs: Port[] = [];
  const seenOutputIds = new Set<string>();
  const pushOutput = (port: Port): void => {
    if (seenOutputIds.has(port.id)) return;
    seenOutputIds.add(port.id);
    outputs.push(port);
  };

  // 输入端口：auto 同名 / manual 映射 / 无映射断开（不产出端口）。
  for (const mapping of plan.mappings) {
    if (mapping.kind !== "input") continue;
    if (mapping.auto && mapping.matchedKey !== undefined) {
      pushInput(makeInPort(mapping.matchedKey));
      continue;
    }
    const target = manualMappings[mapping.currentKey];
    if (target !== undefined) pushInput(makeInPort(target));
  }
  for (const added of plan.addedKeys) {
    if (added.kind === "input") pushInput(makeInPort(added.key));
  }

  // 输出端口：同上，固定 "out" 最后追加（恒存在，不参与去重冲突）。
  for (const mapping of plan.mappings) {
    if (mapping.kind !== "output") continue;
    if (mapping.auto && mapping.matchedKey !== undefined) {
      pushOutput(makeOutPort(mapping.matchedKey));
      continue;
    }
    const target = manualMappings[mapping.currentKey];
    if (target !== undefined) pushOutput(makeOutPort(target));
  }
  for (const added of plan.addedKeys) {
    if (added.kind === "output") pushOutput(makeOutPort(added.key));
  }
  outputs.push(fixedOutPort(node));

  // 断开集合：manual 且未提供映射的端口。
  const disconnected = plan.manual.filter((mapping) => manualMappings[mapping.currentKey] === undefined);
  const edgesToRemove = disconnected.flatMap((mapping) => mapping.edgeIds);
  const manualDisconnected = disconnected.map((mapping) => mapping.currentKey);

  const params = { ...node.params, template: `${templateName}@${targetVersion}` };
  return {
    node: { ...node, inputs, outputs, params },
    edgesToRemove,
    manualDisconnected,
  };
}
