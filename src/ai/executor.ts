// AIExecutor 接口与中断契约：AI 节点执行契约（纯接口，实现由 LangGraphExecutor 提供，T5）。
// v0.2.1：AI 中断（工具审批）——执行器在 agent 中断时抛 AiInterruptRequiredError 信号，由 T5 引擎层转 HumanTask。
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { InputMessage } from "./model.js";
import type { HNFlowTool } from "./types.js";
import type { SqliteDatabase } from "../db/index.js";

/** 执行过程中的进度事件：模型文本、工具调用、工具结果。 */
export interface AIProgressEvent {
  readonly kind: "llm_message" | "tool_call" | "tool_result";
  /** llm_message 时：模型输出文本。 */
  readonly message?: string;
  /** llm_message 时：模型调用 token 用量（从 response_metadata.token_usage 提取，向后兼容）。 */
  readonly tokenUsage?: unknown;
  /** tool_call/tool_result 时：工具名。 */
  readonly toolName?: string;
  /** tool_call 时：调用参数。 */
  readonly toolArgs?: Record<string, unknown>;
  /** tool_result 时：工具返回结果。 */
  readonly toolResult?: unknown;
}

/** AI 中断（工具审批）配置：命中 when 的工具调用将中断等待审批。 */
export interface AIInterruptConfig {
  /** 工具名 → 审批配置（langchain HITL middleware 的 interruptOn）。 */
  readonly interruptOn: Readonly<Record<string, {
    readonly allowedDecisions?: readonly ("approve" | "reject")[];
    readonly description?: string | ((toolCall: unknown, state: unknown, runtime: unknown) => string | Promise<string>);
    readonly when?: (request: unknown) => boolean | Promise<boolean>;
  }>>;
}

/** checkpoint 持久化配置：interrupt 启用时必需（T5 引擎层传共享连接，可与 HumanTask 同库同事务）。 */
export interface AICheckpointDbConfig {
  readonly dbPath: string;
  readonly sharedDb?: SqliteDatabase;
}

/** AI 节点执行请求（executor 组装 ReAct Agent 的输入）。 */
export interface AIExecutionRequest {
  /** 已解析的模型实例。 */
  readonly model: BaseChatModel;
  /** 系统提示词。 */
  readonly systemPrompt?: string;
  /** 可用工具（已注册、已转换前的 HNFlow 定义）。 */
  readonly tools: readonly HNFlowTool[];
  /** 输入消息序列。 */
  readonly inputMessages: readonly InputMessage[];
  /** 进度回调（流式执行时逐事件上报）。 */
  readonly onProgress?: (event: AIProgressEvent) => void;
  /** 是否流式执行（默认 false）。 */
  readonly stream?: boolean;
  /** 中断（工具审批）配置：提供时启用 HITL 流程（须同时提供 checkpointDb）。 */
  readonly interrupt?: AIInterruptConfig;
  /** 线程标识：中断/恢复的持久化键；缺省由执行器生成随机值。 */
  readonly threadId?: string;
  /** checkpoint 持久化：interrupt 启用时必需。 */
  readonly checkpointDb?: AICheckpointDbConfig;
}

/** AI 节点执行结果。 */
export interface AIExecutionResult {
  /** 最终回答文本。 */
  readonly output: string;
  /** 完整轨迹（简化为 role/content）。 */
  readonly messages: readonly { role: string; content: string }[];
  /** 工具调用汇总。 */
  readonly toolCalls: readonly { name: string; args: Record<string, unknown> }[];
}

/** AI 工具审批中断信号：执行器在 agent 中断时抛出，携带恢复所需全部信息。
 *  注意：这是执行器层信号，不做持久化（T5 引擎层负责转 HumanTask 与落库）。 */
export class AiInterruptRequiredError extends Error {
  readonly name = "AiInterruptRequiredError";

  constructor(
    /** 中断值（HITLRequest：value 里的 actionRequests/reviewConfigs 等）。 */
    readonly interruptValue: unknown,
    /** 线程标识：恢复时必须回传。 */
    readonly threadId: string,
    /** checkpoint 标识：恢复目标（传给 config.configurable.checkpoint_id）。 */
    readonly checkpointId: string,
    /** 展示给用户的审批描述。 */
    readonly description: string,
    options?: { cause?: unknown },
  ) {
    super(description, options);
  }
}

/** AI 中断恢复请求：针对 AiInterruptRequiredError 携带的 thread/checkpoint 恢复执行。 */
export interface AIResumeRequest {
  /** 已解析的模型实例（与 execute 相同实例，保证脚本/会话延续）。 */
  readonly model: BaseChatModel;
  /** 可用工具：与 execute 相同集合（恢复后工具执行/再次中断需要）。 */
  readonly tools: readonly HNFlowTool[];
  /** 线程标识：来自 AiInterruptRequiredError.threadId。 */
  readonly threadId: string;
  /** checkpoint 标识：恢复目标（传给 config.configurable.checkpoint_id）。 */
  readonly checkpointId: string;
  /** 人工决策：与中断的 actionRequests 一一对应。 */
  readonly decisions: readonly { readonly type: "approve" | "reject"; readonly message?: string }[];
  /** 系统提示词（可选，重建 agent 用）。 */
  readonly systemPrompt?: string;
  /** 与 execute 相同的中断配置：重建 HITL middleware——多轮审批（恢复后再次中断）必需。 */
  readonly interrupt?: AIInterruptConfig;
  /** checkpoint 持久化：中断数据的落库位置，与 execute 相同。 */
  readonly checkpointDb?: AICheckpointDbConfig;
}

/** 从 HITLRequest（interruptValue）生成人类可读的审批描述：逐条拼接工具名与参数。 */
export function buildInterruptDescription(interruptValue: unknown): string {
  if (typeof interruptValue === "object" && interruptValue !== null) {
    const actionRequests = (interruptValue as { actionRequests?: unknown }).actionRequests;
    if (Array.isArray(actionRequests) && actionRequests.length > 0) {
      const parts: string[] = [];
      for (const action of actionRequests) {
        if (typeof action !== "object" || action === null) {
          continue;
        }
        const record = action as Record<string, unknown>;
        const name = typeof record["name"] === "string" ? record["name"] : "?";
        parts.push(record["args"] === undefined ? name : `${name}(${JSON.stringify(record["args"])})`);
      }
      if (parts.length > 0) {
        return parts.join("; ");
      }
    }
  }
  return "AI 工具调用待审批";
}

/** 单个工具的 HITL 中断配置（interruptOn 的条目类型）。 */
type InterruptOnEntry = AIInterruptConfig["interruptOn"][string];

/** AIInterruptConfig.interruptOn → HITL middleware 配置；allowedDecisions 缺省补全 ["approve", "reject"]。
 *  返回类型复用 AIInterruptConfig.interruptOn 结构（langchain 自身推导在 zod4 下崩溃为 never，见 langgraph-executor）。 */
export function toHitlInterruptOn(
  interruptOn: AIInterruptConfig["interruptOn"],
): AIInterruptConfig["interruptOn"] {
  const result: Record<string, InterruptOnEntry> = {};
  for (const [name, config] of Object.entries(interruptOn)) {
    result[name] = {
      allowedDecisions: config.allowedDecisions !== undefined ? [...config.allowedDecisions] : ["approve", "reject"],
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.when !== undefined ? { when: config.when } : {}),
    };
  }
  return result;
}

/** AI 执行器接口：execute 节点执行；中断信号由 LangGraphExecutor.resume 恢复（v0.2.1）。 */
export interface AIExecutor {
  execute(request: AIExecutionRequest): Promise<AIExecutionResult>;
}
