// AI 节点：调用大模型完成文本/工具调用任务。
// params 边界解析（非法抛 InvalidAIParamsError）→ resolveModel → 工具引用解析 →
// LangGraphExecutor 执行；stream 模式把进度事件转发到节点 logger。
import { LangGraphExecutor } from "../ai/langgraph-executor.js";
import type { AIExecutionRequest, AIProgressEvent } from "../ai/executor.js";
import type { FakeScriptStep } from "../ai/fake-llm.js";
import { resolveModel, type InputMessage, type ModelConfig } from "../ai/model.js";
import { availableTools } from "../ai/toolRegistry.js";
import { resolveToolReferences } from "../ai/tool.js";
import type { INodeDefinition, NodeLogger } from "../execution/types.js";

/** ai 节点 params 非法：字段缺失/类型错误（携带原始值片段与原因）。 */
export class InvalidAIParamsError extends Error {
  readonly name = "InvalidAIParamsError";

  constructor(readonly params: unknown, readonly reason: string) {
    super(`invalid ai params: ${reason}`);
  }
}

/** 解析后的 AI 节点参数。 */
interface AIParams {
  readonly model?: ModelConfig;
  readonly systemPrompt?: string;
  readonly inputMessages?: InputMessage[];
  readonly tools?: readonly string[];
  readonly stream?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取可选字符串字段：值存在但非字符串抛错。 */
function parseOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const raw = record[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new InvalidAIParamsError(record, `${key} 必须是字符串`);
  }
  return raw;
}

/** 解析 model 配置：provider 必填且受支持，可选字段类型校验。 */
function parseModel(value: unknown): ModelConfig {
  if (!isRecord(value)) {
    throw new InvalidAIParamsError(value, "model 必须是对象");
  }
  const provider = value["provider"];
  if (provider !== "openai" && provider !== "fake") {
    throw new InvalidAIParamsError(value, `model.provider 不受支持: "${String(provider)}"`);
  }
  const model = parseOptionalString(value, "model.model");
  const apiKey = parseOptionalString(value, "model.apiKey");
  const baseURL = parseOptionalString(value, "model.baseURL");
  const fakeScriptValue = value["fakeScript"];
  const fakeScript = fakeScriptValue === undefined ? undefined : parseFakeScript(fakeScriptValue);
  return {
    provider,
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(fakeScript !== undefined ? { fakeScript } : {}),
  };
}

/** 解析 fakeScript 数组：逐元素校验 tool_call/text 两种形状。 */
function parseFakeScript(value: unknown): readonly FakeScriptStep[] {
  if (!Array.isArray(value)) {
    throw new InvalidAIParamsError(value, "model.fakeScript 必须是数组");
  }
  return value.map((step, index) => {
    if (!isRecord(step) || (step["kind"] !== "tool_call" && step["kind"] !== "text")) {
      throw new InvalidAIParamsError(value, `model.fakeScript[${index}] 形状非法`);
    }
    if (step["kind"] === "tool_call") {
      const toolCall = step["toolCall"];
      if (
        !isRecord(toolCall) ||
        typeof toolCall["name"] !== "string" ||
        !isRecord(toolCall["args"])
      ) {
        throw new InvalidAIParamsError(value, `model.fakeScript[${index}].toolCall 形状非法`);
      }
    } else if (typeof step["text"] !== "string") {
      throw new InvalidAIParamsError(value, `model.fakeScript[${index}].text 必须是字符串`);
    }
    return step as FakeScriptStep;
  });
}

/** 解析输入消息：字符串 → 单条 user 消息；数组逐元素校验 role/content。 */
function parseInputMessages(value: unknown): InputMessage[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ role: "user", content: value }];
  }
  if (!Array.isArray(value)) {
    throw new InvalidAIParamsError(value, "inputMessages 必须是字符串或消息数组");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry["content"] !== "string") {
      throw new InvalidAIParamsError(value, `inputMessages[${index}] 形状非法`);
    }
    const role = entry["role"];
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new InvalidAIParamsError(value, `inputMessages[${index}].role 非法: "${String(role)}"`);
    }
    return { role: role as InputMessage["role"], content: entry["content"] };
  });
}

/** 解析工具引用数组：每项必须为字符串。 */
function parseTools(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new InvalidAIParamsError(value, "tools 必须是字符串数组");
  }
  for (const [index, ref] of value.entries()) {
    if (typeof ref !== "string") {
      throw new InvalidAIParamsError(value, `tools[${index}] 必须是字符串`);
    }
  }
  return value as string[];
}

/** 解析 systemPrompt：可选，非字符串抛错。 */
function parseSystemPrompt(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidAIParamsError(value, "systemPrompt 必须是字符串");
  }
  return value;
}

/** 解析 stream：可选，非布尔抛错。 */
function parseStream(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new InvalidAIParamsError(value, "stream 必须是布尔值");
  }
  return value;
}

/** 边界解析：从未知参数记录提取 AI 参数，字段缺失取默认，非法抛 InvalidAIParamsError。 */
function parseParams(params: Readonly<Record<string, unknown>>): AIParams {
  const model = params["model"] === undefined ? undefined : parseModel(params["model"]);
  const systemPrompt =
    params["systemPrompt"] === undefined ? undefined : parseSystemPrompt(params["systemPrompt"]);
  const inputMessages =
    params["inputMessages"] === undefined ? undefined : parseInputMessages(params["inputMessages"]);
  const tools = params["tools"] === undefined ? undefined : parseTools(params["tools"]);
  const stream = params["stream"] === undefined ? undefined : parseStream(params["stream"]);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(inputMessages !== undefined ? { inputMessages } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(stream !== undefined ? { stream } : {}),
  };
}

/** 进度事件 → 节点 logger（仅 stream 模式启用，避免刷屏）。 */
function forwardProgress(logger: NodeLogger): (event: AIProgressEvent) => void {
  return (event) => {
    switch (event.kind) {
      case "tool_call":
        logger.info(`工具调用: ${event.toolName ?? ""}`, event.toolArgs);
        break;
      case "tool_result":
        logger.info(`工具结果: ${event.toolName ?? ""}`, event.toolResult);
        break;
      case "llm_message":
        logger.info(event.message ?? "");
        break;
    }
  };
}

const executor = new LangGraphExecutor();

export const aiNode: INodeDefinition = {
  type: "ai",
  name: "AI 节点",
  inputs: [],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
  async execute(ctx) {
    const params = parseParams(ctx.node.params);
    // 默认 provider openai：无 key 时构造不抛，仅运行时模型调用失败。
    const model = resolveModel(params.model ?? { provider: "openai" });
    const tools = resolveToolReferences(params.tools ?? [], availableTools());
    const inputMessages = params.inputMessages ?? [];
    const request: AIExecutionRequest = {
      model,
      tools,
      inputMessages,
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.stream === true ? { stream: true, onProgress: forwardProgress(ctx.logger) } : {}),
    };
    const result = await executor.execute(request);
    return { output: result.output, messages: result.messages, toolCalls: result.toolCalls };
  },
};
