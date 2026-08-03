// file / log 节点集成测试：文件读写往返、追加、错误路径；日志级别分发。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { NodeLogger } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { FileNotFoundError, fileNode, InvalidFileParamsError } from "../src/nodes/file.js";
import { InvalidLogParamsError, logNode } from "../src/nodes/log.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>>): Node {
  return { id, type, name: id, params, inputs: [], outputs: [] };
}

interface CapturedLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

function createMockContext(node: Node, logger?: NodeLogger): NodeExecutionContext {
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
    logger:
      logger ?? {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
  };
}

function captureLogger(captured: CapturedLog[]): NodeLogger {
  return {
    info: (message) => captured.push({ level: "info", message }),
    warn: (message) => captured.push({ level: "warn", message }),
    error: (message) => captured.push({ level: "error", message }),
  };
}

let tmpDir = "";
let cleaned = false;

afterAll(async () => {
  if (tmpDir !== "" && !cleaned) {
    await rm(tmpDir, { recursive: true, force: true });
    cleaned = true;
  }
});

describe("file 节点", () => {
  test("write → read 往返一致", async () => {
    tmpDir = await mkdtemp(join(TEMP_BASE, "hnflow-file-"));
    const filePath = join(tmpDir, "roundtrip.txt");
    const writeNode = makeNode("w", "file", {
      operation: "write",
      path: filePath,
      content: "hello hnflow",
    });
    const writeResult = await fileNode.execute(createMockContext(writeNode));
    expect(writeResult["bytesWritten"]).toBe(12);

    const readNode = makeNode("r", "file", { operation: "read", path: filePath });
    const readResult = await fileNode.execute(createMockContext(readNode));
    expect(readResult["content"]).toBe("hello hnflow");
  });

  test("append 追加到已有内容", async () => {
    const filePath = join(tmpDir, "append.txt");
    await fileNode.execute(
      createMockContext(makeNode("w1", "file", { operation: "write", path: filePath, content: "part1" })),
    );
    await fileNode.execute(
      createMockContext(makeNode("w2", "file", {
        operation: "write",
        path: filePath,
        content: "part2",
        append: true,
      })),
    );
    const readResult = await fileNode.execute(
      createMockContext(makeNode("r", "file", { operation: "read", path: filePath })),
    );
    expect(readResult["content"]).toBe("part1part2");
  });

  test("read 不存在文件 → 抛 FileNotFoundError（消息含路径）", async () => {
    const filePath = join(tmpDir, "missing.txt");
    const node = makeNode("r", "file", { operation: "read", path: filePath });
    const promise = fileNode.execute(createMockContext(node));
    await expect(promise).rejects.toThrow(FileNotFoundError);
    await expect(promise).rejects.toThrow(filePath);
  });

  test("非法 operation → 抛 InvalidFileParamsError", async () => {
    const node = makeNode("x", "file", { operation: "delete", path: join(tmpDir, "a.txt") });
    await expect(fileNode.execute(createMockContext(node))).rejects.toThrow(InvalidFileParamsError);
  });
});

describe("log 节点", () => {
  test("info/warn/error 三种级别执行不抛错且消息送达 logger", async () => {
    const captured: CapturedLog[] = [];
    const logger = captureLogger(captured);
    const cases: Array<{ level: "info" | "warn" | "error"; message: string }> = [
      { level: "info", message: "hello info" },
      { level: "warn", message: "hello warn" },
      { level: "error", message: "hello error" },
    ];
    for (const item of cases) {
      const node = makeNode(`log-${item.level}`, "log", { level: item.level, message: item.message });
      const result = await logNode.execute(createMockContext(node, logger));
      expect(result).toEqual({});
    }
    expect(captured).toEqual([
      { level: "info", message: "hello info" },
      { level: "warn", message: "hello warn" },
      { level: "error", message: "hello error" },
    ]);
  });

  test("缺 message 参数 → 抛 InvalidLogParamsError", async () => {
    const node = makeNode("log", "log", { level: "info" });
    await expect(logNode.execute(createMockContext(node))).rejects.toThrow(InvalidLogParamsError);
  });
});
