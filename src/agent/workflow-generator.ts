// AI 工作流生成器（v0.4.2 验收 1 核心）：把 LLM 结构化 plan 校验并转换为合法 Workflow。
// 纯函数 + zod schema：不依赖 AI 运行时，仅消费 model 校验与节点注册表。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HNFlowTool } from "../ai/types.js";
import { validateWorkflow } from "../model/validate.js";
import type { Edge, Node, Workflow } from "../model/types.js";
import { registry } from "../nodes/registry.js";

/** AI 可生成的节点类型子集（从 registry.list() 过滤，顺序即展示顺序）。 */
export const GENERATABLE_NODE_TYPES: readonly string[] = [
  "command",
  "http",
  "file",
  "setVariable",
  "log",
  "ifElse",
];

/** 各类型用途说明：availableNodeKinds 拼装给 LLM 看。 */
const NODE_KIND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  command: "执行外部命令行程序，捕获 stdout/stderr/退出码（有副作用）",
  http: "发送 HTTP 请求，输出状态/响应体/json（有副作用）",
  file: "读写文件，输出内容/写入字节数（有副作用）",
  setVariable: "把值写入变量路径（如 workflow:key），可引用上游输出",
  log: "输出日志，不影响数据流",
  ifElse: "条件分支：按 condition 求值，输出 true/false 双端口",
};

/** 生成失败：消息为中文，供上层喂回模型重试。 */
export class WorkflowGenerationError extends Error {
  readonly name = "WorkflowGenerationError";

  constructor(message: string) {
    super(message);
  }
}

/** 返回给 LLM 看的可用节点类型描述（每类型一句话，含审核标记说明）。 */
export function availableNodeKinds(): string {
  const lines = GENERATABLE_NODE_TYPES.filter((type) => registry.has(type)).map((type) => {
    const desc = NODE_KIND_DESCRIPTIONS[type] ?? "";
    const review =
      type === "command"
        ? "；生成时自动标记 params.reviewRequired=true、params.generatedBy='ai'，需人工审核"
        : "";
    return `- ${type}: ${desc}${review}`;
  });
  return `可生成节点类型：\n${lines.join("\n")}`;
}

/**
 * LLM 结构化输出契约。
 * - nodes 每项 { type, name, params? }：id 由生成器自动生成（n1/n2/...），schema 不要求 id；
 * - edges 每项 { from, to }：引用节点 name（兼容生成 id），生成器映射为最终 id；
 * - workflowName 可选：缺省用生成函数参数或默认名。
 */
export const workflowPlanSchema = z.object({
  workflowName: z.string().optional(),
  nodes: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1, "节点列表不能为空"),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
    }),
  ),
});

export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;

/** 校验类型在可生成子集内；非法抛中文错误（含可用清单）。 */
function requireGeneratableType(type: string): void {
  if (!GENERATABLE_NODE_TYPES.includes(type)) {
    throw new WorkflowGenerationError(
      `不支持的节点类型 "${type}"，可用类型：${GENERATABLE_NODE_TYPES.join("/")}`,
    );
  }
}

/**
 * 生成工作流：plan（unknown）→ 合法 Workflow。
 * 流程：schema 解析 → 分配 id → 组装节点（command 注入审核标记）→ 解析显式边
 * → 自动补 start/end 与边 → validateWorkflow 校验。任一环节非法抛 WorkflowGenerationError。
 */
export function generateWorkflowFromPlan(rawPlan: unknown, workflowName?: string): Workflow {
  // 1. schema 解析：结构非法 → 中文错误（含字段路径与 zod 消息）。
  const parsed = workflowPlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`)
      .join("；");
    throw new WorkflowGenerationError(`计划格式非法（${detail}），请按工具说明重新输出`);
  }
  const plan = parsed.data;

  // 2. 分配生成 id（n1/n2/...）并构建 name → id 映射；name 重复或类型非法 → 明确报错。
  const ids: string[] = [];
  const byName = new Map<string, string>();
  for (const [index, node] of plan.nodes.entries()) {
    const id = `n${index + 1}`;
    ids.push(id);
    if (byName.has(node.name)) {
      throw new WorkflowGenerationError(`节点名称重复："${node.name}"，请使用唯一名称`);
    }
    byName.set(node.name, id);
    requireGeneratableType(node.type);
  }

  // 3. 组装节点：command 自动注入审核标记（reviewRequired + generatedBy）。
  const nodeById = new Map<string, Node>();
  const nodes: Node[] = plan.nodes.map((node, index) => {
    const def = registry.get(node.type);
    const baseParams = node.params ?? {};
    const params =
      node.type === "command" ? { ...baseParams, reviewRequired: true, generatedBy: "ai" } : baseParams;
    const built: Node = {
      id: ids[index] ?? `n${index + 1}`,
      type: node.type,
      name: node.name,
      params,
      inputs: def.inputs,
      outputs: def.outputs,
    };
    nodeById.set(built.id, built);
    return built;
  });

  // 4. 解析显式边：from/to 先按 name 后按生成 id 匹配；端口不可表示 → 中文报错。
  const resolveRef = (ref: string): string => {
    const byNameHit = byName.get(ref);
    if (byNameHit !== undefined) return byNameHit;
    if (ids.includes(ref)) return ref;
    throw new WorkflowGenerationError(`边引用了不存在的节点："${ref}"（应为节点 name）`);
  };
  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const outDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const edges: Edge[] = plan.edges.map((edge, index) => {
    const sourceId = resolveRef(edge.from);
    const targetId = resolveRef(edge.to);
    const source = nodeById.get(sourceId);
    const target = nodeById.get(targetId);
    if (source === undefined || target === undefined) {
      throw new WorkflowGenerationError(`边引用的节点不存在："${edge.from}" → "${edge.to}"`);
    }
    const sourcePort = source.outputs[0];
    const targetPort = target.inputs[0];
    if (sourcePort === undefined || targetPort === undefined) {
      throw new WorkflowGenerationError(
        `无法连接 "${edge.from}" → "${edge.to}"：${source.type} 无输出端口或 ${target.type} 无输入端口。` +
          `仅 ${GENERATABLE_NODE_TYPES.filter((t) => registry.get(t).inputs.length > 0).join("/")} 可作为边的目标，请调整`,
      );
    }
    inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
    outDegree.set(sourceId, (outDegree.get(sourceId) ?? 0) + 1);
    return {
      id: `e${index + 1}`,
      sourceNodeId: sourceId,
      sourcePortId: sourcePort.id,
      targetNodeId: targetId,
      targetPortId: targetPort.id,
    };
  });

  // 5. 自动补 start/end 节点与边。
  const startDef = registry.get("start");
  const endDef = registry.get("end");
  const startBuilt: Node = {
    id: "start",
    type: "start",
    name: "开始",
    params: {},
    inputs: startDef.inputs,
    outputs: startDef.outputs,
  };
  const endBuilt: Node = {
    id: "end",
    type: "end",
    name: "结束",
    params: {},
    inputs: endDef.inputs,
    outputs: endDef.outputs,
  };
  nodes.push(startBuilt, endBuilt);
  let nextEdgeIndex = plan.edges.length;
  const pushEdge = (
    sourceNodeId: string,
    sourcePortId: string,
    targetNodeId: string,
    targetPortId: string,
  ): void => {
    nextEdgeIndex += 1;
    edges.push({ id: `e${nextEdgeIndex}`, sourceNodeId, sourcePortId, targetNodeId, targetPortId });
  };
  // 起点：第一个「有输入端口且无入边」的节点 ← start。
  const startOutput = startDef.outputs[0];
  for (const id of ids) {
    const node = nodeById.get(id);
    const targetPort = node?.inputs[0];
    if (node === undefined || targetPort === undefined || startOutput === undefined) continue;
    if ((inDegree.get(id) ?? 0) > 0) continue;
    pushEdge("start", startOutput.id, id, targetPort.id);
    break;
  }
  // 终点：最后一个「有输出端口且无出边」的节点 → end。
  const endInput = endDef.inputs[0];
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (id === undefined) continue;
    const node = nodeById.get(id);
    const outputPort = node?.outputs[0];
    if (node === undefined || outputPort === undefined || endInput === undefined) continue;
    if ((outDegree.get(id) ?? 0) > 0) continue;
    pushEdge(id, outputPort.id, "end", endInput.id);
    break;
  }

  // 6. 组装 Workflow 并校验（环/端口类型/引用完整性），非法 → 中文错误。
  const workflow: Workflow = {
    id: randomUUID(),
    name: workflowName ?? plan.workflowName ?? "AI 生成工作流",
    version: "0.1.0",
    nodes,
    edges,
  };
  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    throw new WorkflowGenerationError(`工作流校验失败：${validation.errors.join("；")}`);
  }
  return workflow;
}

/** 生成 generate_workflow 工具：LLM 调用它把自然语言需求转为合法 Workflow。 */
export function createGenerateWorkflowTool(): HNFlowTool {
  return {
    name: "generate_workflow",
    description:
      `根据用户自然语言需求生成可执行工作流。输出必须符合指定 JSON 结构：` +
      `{ workflowName?: string, nodes: [{ type, name, params? }], edges: [{ from, to }] }，` +
      `edges 的 from/to 引用节点 name。仅 ifElse 有输入端口可作为边的目标；` +
      `command/http/file/setVariable/log 无输入端口，只能作为链起点或终点。` +
      `command 节点生成时自动标记 params.reviewRequired=true、params.generatedBy='ai'，需人工审核。\n${availableNodeKinds()}`,
    parameters: workflowPlanSchema,
    handler: (input) => {
      const workflow = generateWorkflowFromPlan(input);
      const typeCounts: Record<string, number> = {};
      for (const node of workflow.nodes) {
        typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
      }
      return { workflow, summary: { nodeCount: workflow.nodes.length, typeCounts } };
    },
  };
}
