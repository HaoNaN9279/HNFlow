// HTTP 请求节点：fetch 发送 HTTP 请求，输出状态、响应头与响应体。

import type { INodeDefinition } from "../execution/types.js";

/** http 节点参数格式非法（url 缺失或非法） */
export class InvalidHttpParamsError extends Error {
  readonly name = "InvalidHttpParamsError";

  constructor(readonly params: unknown) {
    super(
      "invalid http params: expected { url: string, method?, headers?, body?, timeoutMs?, retry? }",
    );
  }
}

/** fetch 网络层失败（含超时），消息含 url 与原因，原始错误经 Error.cause 保留 */
export class HttpRequestError extends Error {
  readonly name = "HttpRequestError";

  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(
      `http request failed: ${url} (${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    );
  }
}

/** 重试配置（v0.2.5 T3）：attempts=重试次数（总执行 attempts+1 次）；delayMs=每次重试前等待毫秒（缺省 100）。
 * 与 command 节点同形态。method 幂等分级：attempts 缺省时 GET/HEAD/OPTIONS（幂等安全）默认重试 1 次，
 * POST/PUT/PATCH/DELETE 默认 0 次；显式传入 attempts 则一律按其值执行。无 retry 字段一律不重试（保持默认行为）。 */
interface RetryOptions {
  readonly attempts: number | undefined;
  readonly delayMs: number;
}

/** 解析后的 HTTP 参数 */
interface HttpParams {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly retry: RetryOptions | undefined;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([, entry]) => typeof entry === "string");
}

/** 解析 retry 配置：缺省返回 undefined（不重试）；结构非法返回 undefined（走参数错误）。 */
function parseRetry(raw: unknown): RetryOptions | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const attempts = record["attempts"];
  if (attempts !== undefined && typeof attempts !== "number") {
    return undefined;
  }
  const delayMs = record["delayMs"];
  if (delayMs !== undefined && typeof delayMs !== "number") {
    return undefined;
  }
  return {
    attempts: attempts === undefined ? undefined : attempts,
    delayMs: delayMs === undefined ? 100 : delayMs,
  };
}

/** HTTP 幂等安全方法（GET/HEAD/OPTIONS）：attempts 缺省时默认可重试；写类方法默认不重试。 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** 解析有效重试次数（v0.2.5 method 幂等分级）：显式 attempts 优先；缺省时幂等方法默认 1 次、其余 0 次；无 retry 一律 0。 */
function resolveRetryAttempts(retry: RetryOptions | undefined, method: string): number {
  if (retry === undefined) {
    return 0;
  }
  if (retry.attempts !== undefined) {
    return Math.max(0, Math.floor(retry.attempts));
  }
  return IDEMPOTENT_METHODS.has(method) ? 1 : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 边界解析：从未知参数记录解析 HTTP 参数，非法返回 undefined */
function parseParams(params: Readonly<Record<string, unknown>>): HttpParams | undefined {
  const url = params["url"];
  if (typeof url !== "string") {
    return undefined;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }
  const method = params["method"];
  if (method !== undefined && typeof method !== "string") {
    return undefined;
  }
  const headers = params["headers"];
  if (headers !== undefined && !isStringRecord(headers)) {
    return undefined;
  }
  const timeoutMs = params["timeoutMs"];
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    return undefined;
  }
  const retry = parseRetry(params["retry"]);
  if (retry === undefined && params["retry"] !== undefined) {
    return undefined;
  }
  return {
    method: method === undefined ? "GET" : method.toUpperCase(),
    url: parsedUrl.toString(),
    headers: headers === undefined ? undefined : headers,
    body: params["body"],
    timeoutMs: timeoutMs === undefined ? 30000 : timeoutMs,
    retry,
  };
}

/** 组装 RequestInit：对象 body 自动 JSON 序列化并设置 Content-Type */
function buildRequestInit(params: HttpParams): RequestInit {
  const headers = new Headers(params.headers);
  let body: string | undefined;
  if (params.body !== undefined) {
    if (typeof params.body === "string") {
      body = params.body;
    } else {
      body = JSON.stringify(params.body);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }
  }
  return {
    method: params.method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(params.timeoutMs),
  };
}

/** body 可解析为 JSON 时返回解析结果，否则 undefined */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** 发送单次请求：网络层失败（含超时）抛 HttpRequestError；非 2xx 显式响应不抛错也不重试。 */
async function doRequest(params: HttpParams): Promise<Record<string, unknown>> {
  const init = buildRequestInit(params);
  let resp: Response;
  try {
    resp = await fetch(params.url, init);
  } catch (e) {
    throw new HttpRequestError(params.url, e);
  }
  const body = await resp.text();
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers),
    body,
    json: parseJson(body),
  };
}

export const httpNode: INodeDefinition = {
  type: "http",
  name: "HTTP 请求",
  inputs: [],
  outputs: [
    { id: "status", name: "status", type: "number", direction: "out" },
    { id: "statusText", name: "statusText", type: "string", direction: "out" },
    { id: "headers", name: "headers", type: "any", direction: "out" },
    { id: "body", name: "body", type: "string", direction: "out" },
    { id: "json", name: "json", type: "any", direction: "out" },
  ],
  async execute(ctx) {
    const params = parseParams(ctx.node.params);
    if (params === undefined) {
      throw new InvalidHttpParamsError(ctx.node.params);
    }
    const attempts = resolveRetryAttempts(params.retry, params.method);
    for (let attempt = 0; ; attempt++) {
      try {
        return await doRequest(params);
      } catch (error) {
        // 仅网络层错误（HttpRequestError/超时）重试；达到上限或参数错误立即抛出。
        if (attempt >= attempts || !(error instanceof HttpRequestError)) {
          throw error;
        }
        await sleep(params.retry?.delayMs ?? 100);
      }
    }
  },
};
