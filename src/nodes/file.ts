// 文件读写节点：按 params.operation 读文件或写文件。
// 路径相对当前工作目录解析；写操作自动创建父目录；不做路径安全限制（本地引擎工具）。

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { INodeDefinition } from "../execution/types.js";

/** 文件操作类型 */
type FileOperation = "read" | "write";

/** file 节点参数结构 */
interface FileParams {
  readonly operation: FileOperation;
  readonly path: string;
  readonly content: string | undefined;
  readonly encoding: BufferEncoding;
  readonly append: boolean;
}

/** file 节点参数缺失或格式错误 */
export class InvalidFileParamsError extends Error {
  readonly name = "InvalidFileParamsError";

  constructor(readonly params: Readonly<Record<string, unknown>>) {
    super("invalid file params: expected { operation: 'read' | 'write', path: string, ... }");
  }
}

/** 读取的文件不存在 */
export class FileNotFoundError extends Error {
  readonly name = "FileNotFoundError";

  constructor(readonly path: string) {
    super(`file not found: "${path}"`);
  }
}

function isBufferEncoding(value: unknown): value is BufferEncoding {
  return typeof value === "string";
}

function parseContent(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error["code"] === "ENOENT";
}

/** 边界解析：从未知 params 解析为类型化 FileParams，非法返回 undefined */
function parseFileParams(params: Readonly<Record<string, unknown>>): FileParams | undefined {
  const operation = params["operation"];
  if (operation !== "read" && operation !== "write") {
    return undefined;
  }
  const path = params["path"];
  if (typeof path !== "string") {
    return undefined;
  }
  const rawEncoding = params["encoding"];
  const encoding = rawEncoding === undefined ? "utf8" : isBufferEncoding(rawEncoding) ? rawEncoding : undefined;
  if (encoding === undefined) {
    return undefined;
  }
  const rawAppend = params["append"];
  const append = rawAppend === undefined ? false : rawAppend;
  if (typeof append !== "boolean") {
    return undefined;
  }
  const content = parseContent(params["content"]);
  if (operation === "write" && content === undefined) {
    return undefined;
  }
  return { operation, path, content, encoding, append };
}

export const fileNode: INodeDefinition = {
  type: "file",
  name: "文件读写",
  inputs: [],
  outputs: [
    {
      id: "content",
      name: "content",
      type: "string",
      direction: "out",
      binding: "workflow:fileContent",
    },
    {
      id: "bytesWritten",
      name: "bytesWritten",
      type: "number",
      direction: "out",
      binding: "workflow:fileBytesWritten",
    },
  ],
  async execute(ctx) {
    const params = parseFileParams(ctx.node.params);
    if (params === undefined) {
      throw new InvalidFileParamsError(ctx.node.params);
    }
    if (params.operation === "read") {
      let content: string;
      try {
        content = await readFile(params.path, { encoding: params.encoding });
      } catch (error) {
        if (isEnoent(error)) {
          throw new FileNotFoundError(params.path);
        }
        throw error;
      }
      return { content, bytesWritten: undefined };
    }
    const content = params.content;
    if (content === undefined) {
      throw new InvalidFileParamsError(ctx.node.params);
    }
    await mkdir(dirname(params.path), { recursive: true });
    if (params.append) {
      await appendFile(params.path, content, { encoding: params.encoding });
    } else {
      await writeFile(params.path, content, { encoding: params.encoding });
    }
    const bytesWritten = Buffer.byteLength(content, params.encoding);
    return { content: undefined, bytesWritten };
  },
};
