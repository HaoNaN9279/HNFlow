// AIExecutor 接口：AI 节点执行契约（纯接口，实现由 LangGraphExecutor 提供，T5）。
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { InputMessage } from "./model.js";
import type { HNFlowTool } from "./types.js";

/** 执行过程中的进度事件：模型文本、工具调用、工具结果。 */
export interface AIProgressEvent {
  readonly kind: "llm_message" | "tool_call" | "tool_result";
  /** llm_message 时：模型输出文本。 */
  readonly message?: string;
  /** tool_call/tool_result 时：工具名。 */
  readonly toolName?: string;
  /** tool_call 时：调用参数。 */
  readonly toolArgs?: Record<string, unknown>;
  /** tool_result 时：工具返回结果。 */
  readonly toolResult?: unknown;
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

/** AI 执行器接口：v0.2.0 只做节点执行，不做中断挂起（v0.2.1）。 */
export interface AIExecutor {
  execute(request: AIExecutionRequest): Promise<AIExecutionResult>;
}
