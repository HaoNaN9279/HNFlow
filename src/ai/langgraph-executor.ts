// LangGraphExecutor：AIExecutor 的 LangGraph 实现（v0.2.0 T5；v0.2.1 增加 AI 中断/工具审批）。
// 中断不抛异常：invoke 结果 / stream 最后 chunk 携带 __interrupt__，此处提取 value 与 checkpoint_id，
// 抛 AiInterruptRequiredError 信号（工具失败由 langgraph 转 ToolMessage，不中断 agent——已验证）。
import { createAgent, humanInTheLoopMiddleware, type AgentMiddleware } from "langchain";
import { Command } from "@langchain/langgraph";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { randomUUID } from "node:crypto";
import {
  AiInterruptRequiredError, buildInterruptDescription, toHitlInterruptOn,
  type AICheckpointDbConfig, type AIExecutionRequest, type AIExecutionResult,
  type AIProgressEvent, type AIExecutor, type AIInterruptConfig, type AIResumeRequest,
} from "./executor.js";
import { fromLangChainMessage, toLangChainMessages } from "./model.js";
import { toLangChainTool } from "./tool.js";
import { SqliteCheckpointSaver } from "./checkpoint-saver.js";

/** agent 执行失败（模型调用失败/脚本用尽等）：统一包装，cause 保存原始错误。 */
export class AIExecutionError extends Error {
  readonly name = "AIExecutionError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 中断执行 bundle：agent 与其 checkpointer/线程配置（execute/resume 共享组装）。 */
interface AgentBundle {
  readonly agent: ReturnType<typeof createAgent>;
  readonly checkpointer: SqliteCheckpointSaver;
  readonly threadId: string;
  readonly config: RunnableConfig;
}

/** LangGraph ReAct Agent 执行器：组装 createAgent 并归一化执行结果。 */
export class LangGraphExecutor implements AIExecutor {
  async execute(request: AIExecutionRequest): Promise<AIExecutionResult> {
    try {
      if (request.interrupt !== undefined) {
        return await this.#executeInterruptible(request);
      }
      const agent = createAgent({
        model: request.model,
        tools: request.tools.map(toLangChainTool),
        // exactOptionalPropertyTypes：systemPrompt 仅在提供时传入。
        ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      });
      return request.stream === true ? await this.#stream(agent, request) : await this.#invoke(agent, request);
    } catch (cause) {
      if (cause instanceof AIExecutionError || cause instanceof AiInterruptRequiredError) throw cause;
      throw new AIExecutionError("LangGraph agent 执行失败", { cause });
    }
  }

  /** 恢复中断的执行：重建 agent（同 tools/checkpointer/middleware）并提交人工决策。 */
  async resume(request: AIResumeRequest): Promise<AIExecutionResult> {
    try {
      const bundle = await this.#bundle(request);
      try {
        // checkpoint_id 精确定位中断点；恢复后再次中断（多轮审批）→ 抛新信号（新 checkpointId）。
        return await this.#invokeWithInterrupt(
          bundle,
          new Command({ resume: { decisions: [...request.decisions] } }),
          { configurable: { thread_id: bundle.threadId, checkpoint_id: request.checkpointId } },
        );
      } finally {
        await bundle.checkpointer.close();
      }
    } catch (cause) {
      if (cause instanceof AIExecutionError || cause instanceof AiInterruptRequiredError) throw cause;
      throw new AIExecutionError("LangGraph agent 恢复执行失败", { cause });
    }
  }

  /** 中断路径入口：interrupt 配置存在时走此路径，中断即抛 AiInterruptRequiredError。 */
  async #executeInterruptible(request: AIExecutionRequest): Promise<AIExecutionResult> {
    const bundle = await this.#bundle(request);
    try {
      return request.stream === true
        ? await this.#stream(bundle.agent, request, bundle)
        : await this.#invokeWithInterrupt(
            bundle,
            { messages: toLangChainMessages(request.inputMessages) },
            bundle.config,
          );
    } finally {
      await bundle.checkpointer.close();
    }
  }

  /** 组装中断执行所需：checkpoint saver + agent（含 HITL middleware）+ 线程配置。 */
  async #bundle(request: AIExecutionRequest | AIResumeRequest): Promise<AgentBundle> {
    const checkpointDb = requireCheckpointDb(request.checkpointDb);
    const saver = new SqliteCheckpointSaver(checkpointDb.dbPath, checkpointDb.sharedDb);
    const agent = createAgent({
      model: request.model,
      tools: request.tools.map(toLangChainTool),
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      checkpointer: saver,
      ...(request.interrupt !== undefined ? { middleware: [buildHitlMiddleware(request.interrupt.interruptOn)] } : {}),
    });
    const threadId = request.threadId ?? `ai-${randomUUID()}`;
    return { agent, checkpointer: saver, threadId, config: { configurable: { thread_id: threadId } } };
  }

  /** invoke 并检查中断：结果含 __interrupt__ 时提取 checkpoint_id 抛中断信号。 */
  async #invokeWithInterrupt(
    bundle: AgentBundle,
    input: { messages: BaseMessage[] } | Command,
    config: RunnableConfig,
  ): Promise<AIExecutionResult> {
    const result = await bundle.agent.invoke(input, config);
    const interrupt = readInterrupt(result);
    if (interrupt !== undefined) {
      throw await interruptError(interrupt, bundle.threadId, bundle.checkpointer);
    }
    return this.#extract(result.messages);
  }

  /** invoke 模式：一次调用取最终状态，提取 output/轨迹/工具调用汇总。 */
  async #invoke(agent: ReturnType<typeof createAgent>, request: AIExecutionRequest): Promise<AIExecutionResult> {
    const result = await agent.invoke({ messages: toLangChainMessages(request.inputMessages) });
    return this.#extract(result.messages);
  }

  /** stream(values)：chunk 为完整状态快照，diff 取增量消息逐条触发 onProgress；中断 chunk 只含 __interrupt__。 */
  async #stream(
    agent: ReturnType<typeof createAgent>,
    request: AIExecutionRequest,
    bundle?: AgentBundle,
  ): Promise<AIExecutionResult> {
    const config = bundle === undefined
      ? { streamMode: "values" as const }
      : { configurable: { thread_id: bundle.threadId }, streamMode: "values" as const };
    const stream = await agent.stream({ messages: toLangChainMessages(request.inputMessages) }, config);
    // tool_call_id → 工具名：ToolMessage 关联其来源工具（langgraph 通常也带 name，双保险）。
    const toolCallNames = new Map<string, string>();
    const onProgress = request.onProgress ?? (() => {});
    let messages: BaseMessage[] = [];
    for await (const chunk of stream) {
      if (bundle !== undefined) {
        const interrupt = readInterrupt(chunk);
        if (interrupt !== undefined) throw await interruptError(interrupt, bundle.threadId, bundle.checkpointer);
      }
      const chunkMessages: BaseMessage[] = (chunk as { messages: BaseMessage[] }).messages;
      if (chunkMessages === undefined) continue;
      for (const message of chunkMessages.slice(messages.length)) {
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
      if (message === undefined) continue;
      if (AIMessage.isInstance(message) && (message.tool_calls ?? []).length === 0) {
        output = fromLangChainMessage(message).content;
        break;
      }
    }
    if (output === "") {
      const last = messages[messages.length - 1];
      if (last !== undefined) output = fromLangChainMessage(last).content;
    }
    return {
      output,
      messages: messages.map(fromLangChainMessage),
      toolCalls: this.#collectToolCalls(messages),
    };
  }

  /** 遍历所有 AIMessage 的 tool_calls，汇总 { name, args } 列表。 */
  #collectToolCalls(messages: readonly BaseMessage[]): readonly { name: string; args: Record<string, unknown> }[] {
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

  /** 单条消息 → 进度事件：tool_call / llm_message / tool_result（toolName 缺失时省略字段，对齐 exactOptionalPropertyTypes）。 */
  #emit(message: BaseMessage, toolCallNames: Map<string, string>, onProgress: (event: AIProgressEvent) => void): void {
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls ?? [];
      for (const call of toolCalls) {
        toolCallNames.set(call.id ?? "", call.name);
        onProgress({ kind: "tool_call", toolName: call.name, toolArgs: call.args });
      }
      if (toolCalls.length === 0) {
        const text = fromLangChainMessage(message).content;
        if (text !== "") onProgress({ kind: "llm_message", message: text });
      }
      return;
    }
    if (ToolMessage.isInstance(message)) {
      const toolName = toolCallNames.get(message.tool_call_id) ?? message.name;
      onProgress({ kind: "tool_result", ...(toolName !== undefined ? { toolName } : {}), toolResult: message.content });
    }
  }
}

/** 构造中断信号：取第一个中断的 value + checkpointer 最新 checkpoint_id + 人类可读描述。 */
async function interruptError(
  interrupts: readonly { value?: unknown }[],
  threadId: string,
  checkpointer: SqliteCheckpointSaver,
): Promise<AiInterruptRequiredError> {
  const value = interrupts[0]?.value ?? interrupts;
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  const checkpointId = tuple?.config.configurable?.checkpoint_id;
  if (typeof checkpointId !== "string" || checkpointId === "") {
    throw new Error(`中断后无法从 checkpointer 读取最新 checkpoint_id（线程 ${threadId} 状态缺失）`);
  }
  return new AiInterruptRequiredError(value, threadId, checkpointId, buildInterruptDescription(value));
}

/** 读取结果/stream chunk 的 __interrupt__ 数组；无中断返回 undefined。 */
function readInterrupt(result: unknown): readonly { value?: unknown }[] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const interrupt = (result as { __interrupt__?: unknown }).__interrupt__;
  return Array.isArray(interrupt) && interrupt.length > 0 ? interrupt : undefined;
}

/** interrupt 启用必须提供 checkpointDb：缺失抛中文错误。 */
function requireCheckpointDb(db: AICheckpointDbConfig | undefined): AICheckpointDbConfig {
  if (db === undefined) {
    throw new AIExecutionError("启用 AI 中断（interrupt）必须提供 checkpointDb（线程状态持久化存储）");
  }
  return db;
}

/**
 * 构建 HITL middleware。langchain 1.5.4 的 humanInTheLoopMiddleware 参数类型（InferInteropZodInput）
 * 在 zod4 下崩溃为 never，运行时 zod/v3 schema 校验不受影响——仅绕过失效的静态类型推导。
 */
function buildHitlMiddleware(interruptOn: AIInterruptConfig["interruptOn"]): AgentMiddleware {
  return humanInTheLoopMiddleware({ interruptOn: toHitlInterruptOn(interruptOn) } as unknown as never) as AgentMiddleware;
}
