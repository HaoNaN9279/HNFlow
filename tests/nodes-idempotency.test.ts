// 节点幂等策略集成测试（v0.2.5 T3）：command/http 瞬时错误重试（params.retry）+ file 写冲突策略（params.ifExists）。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { commandNode, InvalidCommandParamsError } from "../src/nodes/command.js";
import { FileExistsError, fileNode, InvalidFileParamsError } from "../src/nodes/file.js";
import { httpNode, HttpRequestError } from "../src/nodes/http.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type, name: id, params, inputs: [], outputs: [] };
}

function createMockContext(node: Node): NodeExecutionContext {
  return {
    node, workflowId: "test-wf",
    get() { return undefined; }, set() {}, getByPath() { return undefined; }, setByPath() {}, getAll() { return {}; },
    suspend(): never { throw new Error("suspend not implemented in test mock"); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

interface TestServer { readonly server: Server; readonly url: string; }

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => closeServer(s))); servers.length = 0; });

let tmpDir = "";
let cleaned = false;
beforeAll(async () => { tmpDir = await mkdtemp(join(TEMP_BASE, "hnflow-idem-")); });
afterAll(async () => {
  if (tmpDir !== "" && !cleaned) { await rm(tmpDir, { recursive: true, force: true }); cleaned = true; }
});

/** node -e 计数脚本：执行次数写入 countFile；failFirst 首次退出码 1，timeoutFirst 首次挂起超时。 */
function makeCounterScript(failFirst: boolean, timeoutFirst: boolean): string {
  const slow = timeoutFirst ? "if(c===1)setTimeout(()=>{},100000);" : "";
  const fail = failFirst ? "if(c===1)process.exit(1);" : "";
  return `const fs=require('fs');const p=process.argv[1];let c=0;try{c=Number(fs.readFileSync(p,'utf8'))}catch{}c+=1;fs.writeFileSync(p,String(c));${slow}${fail}console.log('attempt'+c);`;
}

describe("T3 节点幂等策略", () => {
  test("command 首次非零退出 → 重试第二次成功（spawn 计数=2）", async () => {
    const countFile = join(tmpDir, "cmd-retry.txt");
    const node = makeNode("cmd", "command", { command: "node", args: ["-e", makeCounterScript(true, false), countFile], failOnNonZero: true, retry: { attempts: 1, delayMs: 0 } });
    const result = await commandNode.execute(createMockContext(node));
    expect(await readFile(countFile, "utf8")).toBe("2");
    expect(result["stdout"]).toContain("attempt2");
    expect(result["exitCode"]).toBe(0);
  });
  test("command 参数错误不重试（立即抛 InvalidCommandParamsError）", async () => {
    const node = makeNode("cmd", "command", { args: ["-e", "console.log('x')"], retry: { attempts: 3, delayMs: 0 } });
    await expect(commandNode.execute(createMockContext(node))).rejects.toThrow(InvalidCommandParamsError);
  });
  test("command 非瞬时错误不重试（failOnNonZero=false 非零退出正常返回，spawn 计数=1）", async () => {
    const countFile = join(tmpDir, "cmd-nontransient.txt");
    const node = makeNode("cmd", "command", { command: "node", args: ["-e", makeCounterScript(true, false), countFile], failOnNonZero: false, retry: { attempts: 3, delayMs: 0 } });
    const result = await commandNode.execute(createMockContext(node));
    expect(await readFile(countFile, "utf8")).toBe("1");
    expect(result["exitCode"]).toBe(1);
  });
  test("command TimeoutError 重试：首次超时第二次成功（spawn 计数=2）", async () => {
    const countFile = join(tmpDir, "cmd-timeout.txt");
    const node = makeNode("cmd", "command", { command: "node", args: ["-e", makeCounterScript(false, true), countFile], timeoutMs: 80, retry: { attempts: 1, delayMs: 0 } });
    const result = await commandNode.execute(createMockContext(node));
    expect(await readFile(countFile, "utf8")).toBe("2");
    expect(result["exitCode"]).toBe(0);
  });
  test("http GET 网络错误重试成功：显式 attempts 与缺省（幂等分级）均重试", async () => {
    for (const retry of [{ attempts: 1, delayMs: 0 }, {}]) {
      let count = 0;
      const { server, url } = await startServer((_req, res) => {
        count += 1;
        if (count === 1) { res.destroy(); return; }
        res.statusCode = 200; res.end("ok");
      });
      servers.push(server);
      const node = makeNode("http", "http", { url, method: "GET", retry });
      const result = await httpNode.execute(createMockContext(node));
      expect(count).toBe(2);
      expect(result["status"]).toBe(200);
    }
  });
  test("http 非 2xx 显式响应不重试（server 只收到 1 次）", async () => {
    let count = 0;
    const { server, url } = await startServer((_req, res) => { count += 1; res.statusCode = 500; res.end("err"); });
    servers.push(server);
    const node = makeNode("http", "http", { url, method: "GET", retry: { attempts: 3, delayMs: 0 } });
    const result = await httpNode.execute(createMockContext(node));
    expect(count).toBe(1);
    expect(result["status"]).toBe(500);
  });
  test("http POST 无 retry 或缺省 attempts → 网络错误不重试（server 只收到 1 次）", async () => {
    const retries: Array<Readonly<Record<string, unknown>> | undefined> = [undefined, {}];
    for (const retry of retries) {
      let count = 0;
      const { server, url } = await startServer((_req, res) => { count += 1; res.destroy(); });
      servers.push(server);
      const node = makeNode("http", "http", { url, method: "POST", ...(retry === undefined ? {} : { retry }) });
      await expect(httpNode.execute(createMockContext(node))).rejects.toThrow(HttpRequestError);
      expect(count).toBe(1);
    }
  });
  test("http POST 显式 retry 才重试：网络错误第二次成功", async () => {
    let count = 0;
    const { server, url } = await startServer((_req, res) => {
      count += 1;
      if (count === 1) { res.destroy(); return; }
      res.statusCode = 200; res.end("ok");
    });
    servers.push(server);
    const node = makeNode("http", "http", { url, method: "POST", retry: { attempts: 1, delayMs: 0 } });
    const result = await httpNode.execute(createMockContext(node));
    expect(count).toBe(2);
    expect(result["status"]).toBe(200);
  });
  test("file ifExists=skip 已存在 → 不覆盖（内容保持）返回 skipped:true", async () => {
    const filePath = join(tmpDir, "skip-exists.txt");
    await fileNode.execute(createMockContext(makeNode("w1", "file", { operation: "write", path: filePath, content: "original" })));
    const result = await fileNode.execute(createMockContext(makeNode("w2", "file", { operation: "write", path: filePath, content: "new", ifExists: "skip" })));
    expect(result["skipped"]).toBe(true);
    expect(result["path"]).toBe(filePath);
    expect(await readFile(filePath, "utf8")).toBe("original");
  });
  test("file ifExists=skip 不存在 → 正常写入", async () => {
    const filePath = join(tmpDir, "skip-missing.txt");
    const result = await fileNode.execute(createMockContext(makeNode("w", "file", { operation: "write", path: filePath, content: "hello", ifExists: "skip" })));
    expect(result["skipped"]).toBeUndefined();
    expect(result["bytesWritten"]).toBe(5);
    expect(await readFile(filePath, "utf8")).toBe("hello");
  });
  test("file ifExists=error 已存在 → 抛 FileExistsError（可被 tryCatch 捕获）", async () => {
    const filePath = join(tmpDir, "error-exists.txt");
    await fileNode.execute(createMockContext(makeNode("w1", "file", { operation: "write", path: filePath, content: "old" })));
    try {
      await fileNode.execute(createMockContext(makeNode("w2", "file", { operation: "write", path: filePath, content: "new", ifExists: "error" })));
      throw new Error("expected FileExistsError");
    } catch (e) {
      expect(e).toBeInstanceOf(FileExistsError);
    }
    expect(await readFile(filePath, "utf8")).toBe("old");
  });
  test("file 默认 ifExists=overwrite 回归：已存在文件被覆盖", async () => {
    const filePath = join(tmpDir, "overwrite.txt");
    await fileNode.execute(createMockContext(makeNode("w1", "file", { operation: "write", path: filePath, content: "old" })));
    await fileNode.execute(createMockContext(makeNode("w2", "file", { operation: "write", path: filePath, content: "new" })));
    expect(await readFile(filePath, "utf8")).toBe("new");
  });
  test("file append 重复执行内容重复（确认非幂等语义）", async () => {
    const filePath = join(tmpDir, "append-repeat.txt");
    await fileNode.execute(createMockContext(makeNode("a1", "file", { operation: "write", path: filePath, content: "x", append: true })));
    await fileNode.execute(createMockContext(makeNode("a2", "file", { operation: "write", path: filePath, content: "x", append: true })));
    expect(await readFile(filePath, "utf8")).toBe("xx");
  });
  test("file ifExists 非法值 → 抛 InvalidFileParamsError", async () => {
    const node = makeNode("w", "file", { operation: "write", path: join(tmpDir, "bad.txt"), content: "x", ifExists: "clobber" });
    await expect(fileNode.execute(createMockContext(node))).rejects.toThrow(InvalidFileParamsError);
  });
});
