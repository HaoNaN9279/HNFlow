// LangGraphExecutor：AIExecutor 的 LangGraph 实现（v0.2.0 T5）。
// 用 createAgent 封装 ReAct Agent：invoke 一次性执行 / stream(values) 逐事件上报进度。
// 工具执行失败由 langgraph 内部转成 ToolMessage（含错误文本），不中断 agent——已验证。
import { createAgent } from "langchain";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  AIExecutionRequest,
  AIExecutionResult,
  AIProgressEvent,
  AIExecutor,
} from "./executor.js";
import { fromLangChainMessage, toLangChainMessages } from "./model.js";
import { toLangChainTool } from "./tool.js";

/** agent 执行失败（模型调用失败/脚本用尽等）：统一包装，cause 保存原始错误。 */
export class AIExecutionError extends Error {
  readonly name = "AIExecutionError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** LangGraph ReAct Agent 执行器：组装 createAgent 并归一化执行结果。 */
export class LangGraphExecutor implements AIExecutor {
  async execute(request: AIExecutionRequest): Promise<AIExecutionResult> {
    try {
      const agent = createAgent({
        model: request.model,
        tools: request.tools.map(toLangChainTool),
        // exactOptionalPropertyTypes：systemPrompt 仅在提供时传入。
        ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      });
      return request.stream === true
        ? await this.#stream(agent, request)
        : await this.#invoke(agent, request);
    } catch (cause) {
      if (cause instanceof AIExecutionError) {
        throw cause;
      }
      throw new AIExecutionError("LangGraph agent 执行失败", { cause });
    }
  }

  /** invoke 模式：一次调用取最终状态，提取 output/轨迹/工具调用汇总。 */
  async #invoke(
    agent: ReturnType<typeof createAgent>,
    request: AIExecutionRequest,
  ): Promise<AIExecutionResult> {
    const result = await agent.invoke({
      messages: toLangChainMessages(request.inputMessages),
    });
    return this.#extract(result.messages);
  }

  /**
   * stream 模式：streamMode "values" 每个 chunk 是完整状态快照（累积消息数组），
   * 与上一 chunk 的 messages 长度做 diff 取增量，逐条按消息类型触发 onProgress。
   */
  async #stream(
    agent: ReturnType<typeof createAgent>,
    request: AIExecutionRequest,
  ): Promise<AIExecutionResult> {
    const stream = await agent.stream(
      { messages: toLangChainMessages(request.inputMessages) },
      { streamMode: "values" },
    );
    // tool_call_id → 工具名：ToolMessage 关联其来源工具（langgraph 通常也带 name，双保险）。
    const toolCallNames = new Map<string, string>();
    const onProgress = request.onProgress ?? (() => {});
    let messages: BaseMessage[] = [];
    for await (const chunk of stream) {
      const chunkMessages: BaseMessage[] = (chunk as { messages: BaseMessage[] }).messages;
      const newMessages = chunkMessages.slice(messages.length);
      for (const message of newMessages) {
        this.#emit(message, toolCallNames, onProgress);
      }
      messages = chunkMessages;
    }
    return this.#extract(messages);
  }

  /** 从最终消息数组提取输出：从后往前找最后一条纯文本 AIMessage，兜底取最后消息文本。 */
  #extract(messages: readonly BaseMessage[]): AIExecutionResult {
    let output = "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message === undefined) {
        continue;
      }
      if (AIMessage.isInstance(message) && (message.tool_calls ?? []).length === 0) {
        output = fromLangChainMessage(message).content;
        break;
      }
    }
    if (output === "") {
      const last = messages[messages.length - 1];
      if (last !== undefined) {
        output = fromLangChainMessage(last).content;
      }
    }
    return {
      output,
      messages: messages.map(fromLangChainMessage),
      toolCalls: this.#collectToolCalls(messages),
    };
  }

  /** 遍历所有 AIMessage 的 tool_calls，汇总 { name, args } 列表。 */
  #collectToolCalls(
    messages: readonly BaseMessage[],
  ): readonly { name: string; args: Record<string, unknown> }[] {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    for (const message of messages) {
      if (AIMessage.isInstance(message)) {
        for (const call of message.tool_calls ?? []) {
          calls.push({ name: call.name, args: call.args });
        }
      }
    }
    return calls;
  }

  /**
   * 单条消息 → 进度事件：
   * - AIMessage 带 tool_calls → 每个调用一个 tool_call 事件；
   * - AIMessage 纯文本（非空）→ llm_message 事件；
   * - ToolMessage → tool_result 事件（工具名优先按 tool_call_id 关联，缺失用 message.name）。
   */
  #emit(
    message: BaseMessage,
    toolCallNames: Map<string, string>,
    onProgress: (event: AIProgressEvent) => void,
  ): void {
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls ?? [];
      for (const call of toolCalls) {
        toolCallNames.set(call.id ?? "", call.name);
        onProgress({ kind: "tool_call", toolName: call.name, toolArgs: call.args });
      }
      if (toolCalls.length === 0) {
        const text = fromLangChainMessage(message).content;
        if (text !== "") {
          onProgress({ kind: "llm_message", message: text });
        }
      }
      return;
    }
    if (ToolMessage.isInstance(message)) {
      const toolName = toolCallNames.get(message.tool_call_id) ?? message.name;
      // exactOptionalPropertyTypes：toolName 缺失时省略字段而非显式 undefined。
      onProgress({
        kind: "tool_result",
        ...(toolName !== undefined ? { toolName } : {}),
        toolResult: message.content,
      });
    }
  }
}
