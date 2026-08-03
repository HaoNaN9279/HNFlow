// HTTP 请求节点：fetch 发送 HTTP 请求，输出状态、响应头与响应体。

import type { INodeDefinition } from "../execution/types.js";

/** http 节点参数格式非法（url 缺失或非法） */
export class InvalidHttpParamsError extends Error {
  readonly name = "InvalidHttpParamsError";

  constructor(readonly params: unknown) {
    super(
      "invalid http params: expected { url: string, method?, headers?, body?, timeoutMs? }",
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

/** 解析后的 HTTP 参数 */
interface HttpParams {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
  readonly timeoutMs: number;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([, entry]) => typeof entry === "string");
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
  return {
    method: method === undefined ? "GET" : method.toUpperCase(),
    url: parsedUrl.toString(),
    headers: headers === undefined ? undefined : headers,
    body: params["body"],
    timeoutMs: timeoutMs === undefined ? 30000 : timeoutMs,
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
  },
};
