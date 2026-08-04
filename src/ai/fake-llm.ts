// FakeLLM：脚本化假聊天模型，按脚本序列返回 AIMessage（tool_call → text），
// 用于驱动 ReAct 工具调用循环（createAgent 集成冒烟）与单元测试。
// 官方 FakeListChatModel 只返回纯文本、不产生 tool_calls，故自写此测试设施。
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";

/** 单次工具调用描述（与 langchain ToolCall 形状一致）。 */
export type FakeToolCall = { name: string; args: Record<string, unknown>; id?: string };

/** 脚本步：工具调用或纯文本。 */
export type FakeScriptStep =
  | { kind: "tool_call"; toolCall: FakeToolCall }
  | { kind: "text"; text: string };

/** FakeLLM 构造参数。 */
export interface FakeLLMParams {
  /** 脚本序列：每次模型调用按序推进，用完抛 FakeScriptExhaustedError。 */
  script: readonly FakeScriptStep[];
  /** 每次 _generate 的模拟延迟（毫秒），默认 0。 */
  delayMs?: number;
}

/** 脚本用尽错误：脚本步数少于模型调用次数时抛出，用于暴露测试脚本长度错误。 */
export class FakeScriptExhaustedError extends Error {
  constructor(totalSteps: number) {
    super(`FakeLLM 脚本已用尽：共 ${totalSteps} 步，但发生了第 ${totalSteps + 1} 次模型调用`);
    this.name = "FakeScriptExhaustedError";
  }
}

/** 脚本化假聊天模型：继承 BaseChatModel，第 N 次调用返回脚本第 N 步。 */
export class FakeLLM extends BaseChatModel {
  readonly #script: readonly FakeScriptStep[];
  readonly #delayMs: number;
  #stepIndex = 0;
  #boundTools: BindToolsInput[] = [];

  constructor(params: FakeLLMParams) {
    super({});
    this.#script = params.script;
    this.#delayMs = params.delayMs ?? 0;
  }

  /** langchain 模型类型标识。 */
  _llmType(): string {
    return "hnflow-fake";
  }

  /** 已推进的脚本步数（测试断言用）。 */
  get stepIndex(): number {
    return this.#stepIndex;
  }

  /** bindTools 记录的工具列表（测试断言用）。 */
  get boundTools(): readonly BindToolsInput[] {
    return this.#boundTools;
  }

  /**
   * 绑定工具：记录列表并返回自身。
   * 注意：不能暴露名为 tools 的非空属性——createAgent 的 validateLLMHasNoBoundTools
   * 会据此抛 MultipleToolsBoundError；存 boundTools 可避开该检查。
   */
  override bindTools(
    tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    this.#boundTools = [...tools];
    return this;
  }

  /** 核心：按脚本推进，返回当前步对应的 AIMessage。 */
  override async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    const index = this.#stepIndex;
    const step = this.#script[index];
    if (step === undefined) {
      throw new FakeScriptExhaustedError(this.#script.length);
    }
    this.#stepIndex += 1;
    const message =
      step.kind === "tool_call"
        ? this.#toolCallMessage(step.toolCall, index)
        : new AIMessage({ content: step.text });
    return { generations: [{ message, text: step.kind === "text" ? step.text : "" }] };
  }

  /** 构造带 tool_calls 的 AIMessage：id 取脚本提供值，缺省按步号自动生成。 */
  #toolCallMessage(toolCall: FakeToolCall, index: number): AIMessage {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          name: toolCall.name,
          args: toolCall.args,
          id: toolCall.id ?? `call_${index}`,
        },
      ],
    });
  }
}
