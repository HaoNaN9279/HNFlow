// LLM 节点：纯文本大模型调用（无工具、无中断），与 ai 节点共用同一 AIExecutor（统一运行时）。
// params 边界解析（非法抛 InvalidLLMParamsError）→ resolveModel → LangGraphExecutor 执行；
// 复用 ai 节点的 parseModel/forwardProgress，避免重复实现。
import { aiExecutor } from "../ai/executor-instance.js";
import type { AIExecutionRequest } from "../ai/executor.js";
import { resolveModel, type InputMessage, type ModelConfig } from "../ai/model.js";
import type { INodeDefinition } from "../execution/types.js";
import { forwardProgress, InvalidAIParamsError, parseModel as parseModelForAI } from "./ai.js";

/** llm 节点 params 非法：字段缺失/类型错误（携带原始值片段与原因）。 */
export class InvalidLLMParamsError extends Error {
  readonly name = "InvalidLLMParamsError";

  constructor(readonly params: unknown, readonly reason: string) {
    super(`invalid llm params: ${reason}`);
  }
}

/** 解析后的 LLM 节点参数。 */
interface LLMParams {
  readonly model?: ModelConfig;
  readonly systemPrompt?: string;
  readonly inputMessages?: InputMessage[];
  readonly stream?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 复用 ai 节点 model 解析逻辑，错误统一转 InvalidLLMParamsError。 */
function parseModel(value: unknown): ModelConfig {
  try {
    return parseModelForAI(value);
  } catch (error) {
    if (error instanceof InvalidAIParamsError) {
      throw new InvalidLLMParamsError(error.params, error.reason);
    }
    throw error;
  }
}

/** 解析 systemPrompt：可选，非字符串抛错。 */
function parseSystemPrompt(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidLLMParamsError(value, "systemPrompt 必须是字符串");
  }
  return value;
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
    throw new InvalidLLMParamsError(value, "inputMessages 必须是字符串或消息数组");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry["content"] !== "string") {
      throw new InvalidLLMParamsError(value, `inputMessages[${index}] 形状非法`);
    }
    const role = entry["role"];
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new InvalidLLMParamsError(value, `inputMessages[${index}].role 非法: "${String(role)}"`);
    }
    return { role: role as InputMessage["role"], content: entry["content"] };
  });
}

/** 解析 stream：可选，非布尔抛错。 */
function parseStream(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new InvalidLLMParamsError(value, "stream 必须是布尔值");
  }
  return value;
}

/** 边界解析：从未知参数记录提取 LLM 参数，字段缺失取默认，非法抛 InvalidLLMParamsError。 */
function parseParams(params: Readonly<Record<string, unknown>>): LLMParams {
  const model = params["model"] === undefined ? undefined : parseModel(params["model"]);
  const systemPrompt =
    params["systemPrompt"] === undefined ? undefined : parseSystemPrompt(params["systemPrompt"]);
  const inputMessages =
    params["inputMessages"] === undefined ? undefined : parseInputMessages(params["inputMessages"]);
  const stream = params["stream"] === undefined ? undefined : parseStream(params["stream"]);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(inputMessages !== undefined ? { inputMessages } : {}),
    ...(stream !== undefined ? { stream } : {}),
  };
}

export const llmNode: INodeDefinition = {
  type: "llm",
  name: "LLM 节点",
  paramsSchema: [
    { key: "inputMessages", label: "输入提示词", type: "textarea", description: "字符串=单条 user 消息；数组=[{ role, content }]" },
    { key: "systemPrompt", label: "系统提示词", type: "textarea" },
    { key: "model", label: "模型配置", type: "json", default: { provider: "openai" }, description: '{ provider: "openai" | "fake", model?, apiKey?, baseURL?, fakeScript? }' },
    { key: "stream", label: "流式输出", type: "boolean", default: false },
  ],
  inputs: [],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
  async execute(ctx) {
    const params = parseParams(ctx.node.params);
    // 默认 provider openai：无 key 时构造不抛，仅运行时模型调用失败。
    const model = resolveModel(params.model ?? { provider: "openai" });
    const request: AIExecutionRequest = {
      model,
      tools: [],
      inputMessages: params.inputMessages ?? [],
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.stream === true ? { stream: true, onProgress: forwardProgress(ctx.logger) } : {}),
    };
    const result = await aiExecutor.execute(request);
    return { output: result.output, messages: result.messages, toolCalls: result.toolCalls };
  },
};
