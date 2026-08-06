// 主进程 AI 对话逻辑（v0.4.2 验收 1）：自然语言 → Workflow JSON。
// 纯逻辑不依赖 electron：resolveModel + aiExecutor 来自核心库，可独立单测。
//
// 设计：AIExecutionResult.toolCalls 只含 { name, args }，拿不到 generate_workflow 生成的 workflow；
// 故包装 createGenerateWorkflowTool（复用 description/parameters），handler 调
// generateWorkflowFromPlan 并把 workflow 存入闭包，执行结束后从闭包取回。

import { AIExecutionError } from "../../../../src/ai/langgraph-executor.js";
import { aiExecutor } from "../../../../src/ai/executor-instance.js";
import { InvalidModelConfigError, resolveModel, type ModelConfig } from "../../../../src/ai/model.js";
import type { FakeScriptStep } from "../../../../src/ai/fake-llm.js";
import type { HNFlowTool } from "../../../../src/ai/types.js";
import {
  createGenerateWorkflowTool,
  generateWorkflowFromPlan,
  WorkflowGenerationError,
} from "../../../../src/agent/workflow-generator.js";
import type { Workflow } from "../../../../src/model/types.js";
import type { AgentChatModelConfig, AgentChatPayload, AgentChatResult } from "../shared/ipc.js";

/** 系统提示词：说明角色与工具用法（节点清单由 generate_workflow 工具描述自带）。 */
const AGENT_SYSTEM_PROMPT =
  "你是 HNFlow 工作流设计助手。根据用户自然语言需求，调用 generate_workflow 工具生成可执行工作流。" +
  "生成成功后用一句话总结工作流结构；不要虚构未生成的内容。";

/** fake 模型固定计划（演示/测试）：发布流程 = 资源导入 → 打包 → 测试通过分支。 */
const FAKE_PLAN = {
  workflowName: "发布流程",
  nodes: [
    { type: "command", name: "资源导入", params: { command: "npm install" } },
    { type: "http", name: "打包", params: { url: "https://ci.example.com/build" } },
    { type: "ifElse", name: "测试通过", params: { condition: { variable: "cmd:exitCode", op: "eq", value: 0 } } },
  ],
  edges: [{ from: "打包", to: "测试通过" }],
};

/** fake provider 专用脚本：一次工具调用 + 一次文本总结（完整 ReAct 循环）。 */
const FAKE_SCRIPT: readonly FakeScriptStep[] = [
  { kind: "tool_call", toolCall: { name: "generate_workflow", args: FAKE_PLAN } },
  { kind: "text", text: "已生成「发布流程」工作流：资源导入 → 打包 → 测试通过。可点击「应用为新建工作流」载入画布。" },
];

/** IPC 模型配置 → 核心 ModelConfig；fake 注入固定脚本，非法 provider 抛 InvalidModelConfigError。 */
function toModelConfig(raw: AgentChatModelConfig): ModelConfig {
  if (raw.provider !== "openai" && raw.provider !== "fake") {
    throw new InvalidModelConfigError(raw.provider);
  }
  if (raw.provider === "fake") {
    return { provider: "fake", fakeScript: FAKE_SCRIPT };
  }
  return {
    provider: "openai",
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey } : {}),
    ...(raw.baseURL !== undefined ? { baseURL: raw.baseURL } : {}),
  };
}

/** 包装 generate_workflow 工具：handler 生成并捕获 workflow 到闭包（工具返回值转纯文本给模型）。 */
function buildGenerateWorkflowTool(): { readonly tool: HNFlowTool; readonly lastWorkflow: () => Workflow | undefined } {
  const base = createGenerateWorkflowTool();
  let lastWorkflow: Workflow | undefined;
  const tool: HNFlowTool = {
    name: base.name,
    description: base.description,
    parameters: base.parameters,
    handler: (input) => {
      const workflow = generateWorkflowFromPlan(input);
      lastWorkflow = workflow;
      return `工作流生成成功：「${workflow.name}」（${workflow.nodes.length} 个节点）。`;
    },
  };
  return { tool, lastWorkflow: () => lastWorkflow };
}

/** 生成结果摘要：工作流名 + 各类型节点计数（展示在「应用为新建工作流」按钮上）。 */
function summarizeWorkflow(workflow: Workflow): string {
  const counts = new Map<string, number>();
  for (const node of workflow.nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([type, count]) => `${type}×${count}`).join("、");
  return `已生成工作流「${workflow.name}」（共 ${workflow.nodes.length} 个节点：${parts}）`;
}

/** 错误 → 中文消息：生成校验错误原样透传；其余统一「AI 对话失败」前缀并附底层原因。 */
function friendlyChatError(error: unknown): string {
  if (error instanceof WorkflowGenerationError) return error.message;
  if (error instanceof InvalidModelConfigError) return `不支持的模型提供商："${error.provider}"`;
  if (error instanceof AIExecutionError && error.cause instanceof Error && error.cause.message !== "") {
    return `AI 对话失败：${error.cause.message}`;
  }
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  return `AI 对话失败：${message}`;
}

/** 执行 AI 对话：模型 → generate_workflow → 返回回复与（若有）生成的工作流。 */
export async function chatWithAgent(payload: AgentChatPayload): Promise<AgentChatResult> {
  try {
    const model = resolveModel(toModelConfig(payload.model));
    const { tool, lastWorkflow } = buildGenerateWorkflowTool();
    const result = await aiExecutor.execute({
      model,
      tools: [tool],
      systemPrompt: AGENT_SYSTEM_PROMPT,
      inputMessages: payload.messages,
    });
    const workflow = lastWorkflow();
    if (workflow === undefined) {
      return { ok: true, reply: result.output };
    }
    return { ok: true, reply: result.output, workflow, summary: summarizeWorkflow(workflow) };
  } catch (error) {
    return { ok: false, message: friendlyChatError(error) };
  }
}
