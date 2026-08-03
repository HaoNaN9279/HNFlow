// HTTP 节点集成测试（AC2）：本地 server 验证请求发送与响应处理。
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { httpNode, InvalidHttpParamsError } from "../src/nodes/http.js";

function makeNode(id: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type: "http", name: id, params, inputs: [], outputs: [] };
}

function createMockContext(node: Node): NodeExecutionContext {
  return {
    node,
    workflowId: "test-wf",
    get() {
      return undefined;
    },
    set() {},
    getByPath() {
      return undefined;
    },
    setByPath() {},
    getAll() {
      return {};
    },
    suspend(): never {
      throw new Error("suspend not implemented in test mock");
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

interface TestServer {
  readonly server: Server;
  readonly url: string;
}

/** 启动本地 HTTP server：监听 127.0.0.1 随机端口（port: 0）。 */
function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** 关闭 server：先断开保持的连接再等 close 回调，避免 keep-alive 挂起。 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => closeServer(s)));
  servers.length = 0;
});

describe("AC2 HTTP 节点", () => {
  test("GET 请求 → status 200 / body 正确 / json 解析正确", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, value: 42 }));
    });
    servers.push(server);
    const node = makeNode("http", { url: `${url}/hello`, method: "GET" });
    const result = await httpNode.execute(createMockContext(node));
    expect(result["status"]).toBe(200);
    expect(result["statusText"]).toBe("OK");
    expect(result["body"]).toBe('{"ok":true,"value":42}');
    expect(result["json"]).toEqual({ ok: true, value: 42 });
  });

  test("POST JSON body → server 收到正确 body 与 Content-Type", async () => {
    let receivedBody = "";
    let receivedType = "";
    const { server, url } = await startServer((req, res) => {
      receivedType = req.headers["content-type"] ?? "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      req.on("end", () => {
        res.statusCode = 200;
        res.end("ok");
      });
    });
    servers.push(server);
    const node = makeNode("http", {
      url: `${url}/echo`,
      method: "POST",
      body: { name: "hnflow" },
    });
    const result = await httpNode.execute(createMockContext(node));
    expect(result["status"]).toBe(200);
    expect(receivedBody).toBe('{"name":"hnflow"}');
    expect(receivedType).toContain("application/json");
  });

  test("404 响应 → status 404 / body 正确", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    servers.push(server);
    const node = makeNode("http", { url: `${url}/missing`, method: "GET" });
    const result = await httpNode.execute(createMockContext(node));
    expect(result["status"]).toBe(404);
    expect(result["body"]).toBe("not found");
  });

  test("非法 url（空字符串）→ 抛 InvalidHttpParamsError", async () => {
    const node = makeNode("http", { url: "" });
    await expect(httpNode.execute(createMockContext(node))).rejects.toThrow(InvalidHttpParamsError);
  });
});
