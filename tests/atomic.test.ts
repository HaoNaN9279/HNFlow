// 原子写公共工具与深拷贝公共工具测试。
// 覆盖：正常写入、父目录自动创建、校验失败/rename 失败时的清理与不损坏、深拷贝隔离。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "../src/model/types.js";
import { atomicWriteFile } from "../src/storage/atomic.js";
import { deepCopyWorkflow } from "../src/utils/deepCopy.js";

/** 构造含嵌套 subworkflow、globalVariables、position 的复杂工作流。 */
function makeWorkflow(): Workflow {
  return {
    id: "wf",
    name: "wf",
    version: "0.1.0",
    nodes: [
      {
        id: "outer",
        type: "subflow",
        name: "outer",
        params: { mode: "prod" },
        inputs: [],
        outputs: [],
        position: { x: 1, y: 2 },
        subworkflow: {
          id: "inner",
          name: "inner",
          version: "0.1.0",
          nodes: [
            {
              id: "inner-a",
              type: "start",
              name: "inner-a",
              params: { mode: "prod" },
              inputs: [],
              outputs: [],
            },
          ],
          edges: [],
        },
      },
    ],
    edges: [],
    globalVariables: { config: { retries: 3 }, list: [1, { a: 2 }] },
  };
}

/** 路径是否存在（文件或目录）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atomic-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  test("正常写入：读取内容一致（\\n 结尾）", async () => {
    const filePath = join(dir, "a.json");
    await atomicWriteFile(filePath, "hello\n");
    expect(await readFile(filePath, "utf8")).toBe("hello\n");
  });

  test("父目录不存在时自动创建", async () => {
    const filePath = join(dir, "nested", "deep", "b.json");
    await atomicWriteFile(filePath, "x");
    expect(await readFile(filePath, "utf8")).toBe("x");
  });

  test("模拟校验失败：validate 抛错 → 原文件不受损、tmp 清理、抛错", async () => {
    const filePath = join(dir, "c.json");
    await writeFile(filePath, "original", "utf8");
    await expect(
      atomicWriteFile(filePath, "broken", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await readFile(filePath, "utf8")).toBe("original");
    expect(await exists(`${filePath}.tmp`)).toBe(false);
  });

  test("模拟 rename 失败（目标为已存在目录）→ 目标不受损、tmp 清理、抛错", async () => {
    const targetDir = join(dir, "blocked");
    await mkdir(targetDir, { recursive: true });
    await expect(atomicWriteFile(targetDir, "content")).rejects.toThrow();
    expect(await exists(targetDir)).toBe(true); // 目标目录未被 rename 破坏
    expect(await exists(`${targetDir}.tmp`)).toBe(false); // 残留 tmp 已清理
  });
});

describe("deepCopyWorkflow 深拷贝隔离", () => {
  test("修改副本 node.params 不影响原图", () => {
    const original = makeWorkflow();
    const copy = deepCopyWorkflow(original);
    const copyNode = copy.nodes[0];
    if (copyNode === undefined) throw new Error("node missing");
    const params = copyNode.params as { mode: string };
    params.mode = "dev";
    expect(original.nodes[0]?.params).toEqual({ mode: "prod" });
  });

  test("修改副本嵌套 subworkflow 内节点不影响原图", () => {
    const original = makeWorkflow();
    const copy = deepCopyWorkflow(original);
    const copyNode = copy.nodes[0];
    if (copyNode === undefined || copyNode.subworkflow === undefined) {
      throw new Error("subworkflow missing");
    }
    const innerNode = copyNode.subworkflow.nodes[0];
    if (innerNode === undefined) throw new Error("inner node missing");
    const params = innerNode.params as { mode: string };
    params.mode = "dev";
    expect(original.nodes[0]?.subworkflow?.nodes[0]?.params).toEqual({ mode: "prod" });
  });

  test("修改副本 globalVariables 不影响原图", () => {
    const original = makeWorkflow();
    const copy = deepCopyWorkflow(original);
    if (copy.globalVariables === undefined) throw new Error("globalVariables missing");
    const gv = copy.globalVariables as { config: { retries: number } };
    gv.config.retries = 999;
    const originalGv = original.globalVariables as { config: { retries: number } };
    expect(originalGv.config.retries).toBe(3);
  });

  test("修改副本 node.position 不影响原图", () => {
    const original = makeWorkflow();
    const copy = deepCopyWorkflow(original);
    const copyNode = copy.nodes[0];
    if (copyNode === undefined || copyNode.position === undefined) {
      throw new Error("position missing");
    }
    const position = copyNode.position as { x: number; y: number };
    position.x = 999;
    expect(original.nodes[0]?.position).toEqual({ x: 1, y: 2 });
  });
});
