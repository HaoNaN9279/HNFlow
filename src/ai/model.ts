// 模型标识解析与消息归一化：ModelConfig → BaseChatModel，InputMessage ↔ langchain 消息。
import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
  type ContentBlock,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeLLM, type FakeScriptStep } from "./fake-llm.js";

/** 模型提供商标识。 */
export type ModelProvider = "openai" | "fake";

/** 模型解析配置（exactOptionalPropertyTypes：可选字段仅在赋值时出现）。 */
export interface ModelConfig {
  readonly provider: ModelProvider;
  /** 模型名，openai 缺省 "gpt-4o"。 */
  readonly model?: string;
  /** OpenAI API key；缺省走环境变量 OPENAI_API_KEY。 */
  readonly apiKey?: string;
  /** OpenAI 自定义 base URL（代理/兼容端点）。 */
  readonly baseURL?: string;
  /** fake 专用：脚本序列（resolveModel("fake") 时传给 FakeLLM）。 */
  readonly fakeScript?: readonly FakeScriptStep[];
}

/** AI 节点输入消息格式。 */
export interface InputMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** 非法模型配置错误：provider 不受支持。 */
export class InvalidModelConfigError extends Error {
  readonly name = "InvalidModelConfigError";

  constructor(readonly provider: string) {
    super(`unsupported model provider: "${provider}"`);
  }
}

/** 穷尽 switch 兜底：运行时非法 provider 落到此处抛类型化错误。 */
function assertNever(value: never): never {
  throw new InvalidModelConfigError(String(value));
}

/** 按配置解析模型实例：openai → ChatOpenAI，fake → FakeLLM。 */
export function resolveModel(config: ModelConfig): BaseChatModel {
  switch (config.provider) {
    case "openai": {
      const fields: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: config.model ?? "gpt-4o",
      };
      if (config.apiKey !== undefined) {
        fields.apiKey = config.apiKey;
      }
      if (config.baseURL !== undefined) {
        fields.configuration = { baseURL: config.baseURL };
      }
      return new ChatOpenAI(fields);
    }
    case "fake":
      return new FakeLLM({ script: config.fakeScript ?? [] });
    default:
      return assertNever(config.provider);
  }
}

/** 输入消息归一化为 langchain 消息（system/assistant/user → System/AI/Human）。 */
export function toLangChainMessages(messages: readonly InputMessage[]): BaseMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return new SystemMessage(message.content);
      case "assistant":
        return new AIMessage(message.content);
      case "user":
        return new HumanMessage(message.content);
      default:
        return assertNever(message.role);
    }
  });
}

/** langchain 消息的轻量视图（最终回答提取用）。 */
export interface LangChainMessageView {
  readonly role: string;
  readonly content: string;
}

/** 反向归一化：langchain 消息 → { role, content }，content 取文本。 */
export function fromLangChainMessage(message: BaseMessage): LangChainMessageView {
  return {
    role: message.getType(),
    content: extractText(message.content),
  };
}

/** 从消息 content（string 或内容块数组）提取纯文本。 */
function extractText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
