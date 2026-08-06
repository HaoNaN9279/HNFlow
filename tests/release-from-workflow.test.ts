// 模板发布新内容测试（v0.3.3 T6）：releaseTemplateFromWorkflow 全流程覆盖。
// 与 templates-release.test.ts 同构：mkdtemp 临时目录构造 + Windows 清理（afterAll rmRetry + Bun.gc(true)）。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticVersionError } from "../src/groups/errors.js";
import type { Workflow } from "../src/model/types.js";
import { createTemplate } from "../src/templates/create.js";
import { TemplateFileError, TemplateNotFoundError } from "../src/templates/errors.js";
import { loadTemplate } from "../src/templates/load.js";
import { releaseTemplateFromWorkflow } from "../src/templates/release-from-workflow.js";

const tempRoots: string[] = [];
let tempRoot = "";

afterAll(async () => {
  for (const root of tempRoots) {
    await rmRetry(root);
  }
}, 30000);

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hnflow-release-from-workflow-"));
  tempRoots.push(tempRoot);
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试（Windows 惯例）。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows 句柄释放依赖 GC，强制回收以解锁文件
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造源工作流：外部节点 inject 输出连到选中节点 step 的输入端口 a，
 * 打包后生成 autoInput binding "workflow:params:a"（interface.inputs 起点）。
 */
function makeSourceWorkflow(): Workflow {
  return {
    id: "wf-src",
    name: "源工作流",
    version: "1.0.0",
    nodes: [
      {
        id: "inject",
        type: "setVariable",
        name: "注入",
        params: { target: "workflow:x", value: 1 },
        inputs: [],
        outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
      },
      {
        id: "step",
        type: "setVariable",
        name: "处理",
        params: { target: "workflow:result", value: 1 },
        inputs: [{ id: "a", name: "参数a", type: "any", direction: "in" }],
        outputs: [],
      },
      { id: "end", type: "end", name: "结束", params: {}, inputs: [], outputs: [] },
    ],
    edges: [{ id: "e1", sourceNodeId: "inject", sourcePortId: "out", targetNodeId: "step", targetPortId: "a" }],
  };
}

/** 构造编辑后工作流：step 节点 inputs 挂 binding "workflow:params:<key>"（paramKeys 可含重复，验证有序去重）。 */
function makeEditedWorkflow(paramKeys: readonly string[]): Workflow {
  return {
    id: "wf-edited",
    name: "编辑后工作流",
    version: "1.0.0",
    nodes: [
      {
        id: "step",
        type: "setVariable",
        name: "处理",
        params: { target: "workflow:result", value: 1 },
        inputs: paramKeys.map((key) => ({
          id: `in_${key}`,
          name: key,
          type: "any",
          direction: "in",
          binding: `workflow:params:${key}`,
        })),
        outputs: [{ id: "out", name: "out", type: "any", direction: "out" }],
      },
      { id: "end", type: "end", name: "结束", params: {}, inputs: [], outputs: [] },
    ],
    edges: [],
  };
}

/** 用 T3 createTemplate 构造初始模板（v0.1.0，interface.inputs=["a"]）。 */
async function createDemoTemplate(name: string): Promise<void> {
  await createTemplate(tempRoot, name, makeSourceWorkflow(), ["step", "end"], "演示模板");
}

describe("releaseTemplateFromWorkflow", () => {
  test("成功发布：workflow.json 内容 = 传入 workflow（非拷贝），template.json 的 currentVersion/versions 正确", async () => {
    await createDemoTemplate("demo");

    const edited = makeEditedWorkflow(["b"]);
    const released = await releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", edited);

    expect(released.currentVersion).toBe("1.0.0");
    expect(released.versions).toHaveLength(2);
    expect(released.versions[1]?.version).toBe("1.0.0");

    // 内容直接写新版本快照：读回比对等于传入 workflow（区别于 releaseTemplate 的目录拷贝）
    const written = JSON.parse(await readFile(join(tempRoot, "demo", "v1.0.0", "workflow.json"), "utf8")) as unknown;
    expect(written).toEqual(edited);

    // 读回一致性：返回值可被 loadTemplate 原样读回
    const loaded = await loadTemplate(join(tempRoot, "demo"));
    expect(loaded).toEqual(released);
  });

  test("interface.inputs 重算：binding workflow:params:title/content 端口 → inputs=[title, content]（有序去重），outputs 沿用", async () => {
    await createDemoTemplate("demo"); // interface.inputs=["a"], outputs=["out"]

    const released = await releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", makeEditedWorkflow(["title", "content", "title"]));
    expect(released.interface.inputs).toEqual(["title", "content"]); // 有序去重，不含原 a
    expect(released.interface.outputs).toEqual(["out"]); // 沿用当前模板值
  });

  test("版本不递增（同版本 / 降级）：拒绝且消息含当前版本", async () => {
    await createDemoTemplate("demo");
    await releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", makeEditedWorkflow([]));
    await expect(releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", makeEditedWorkflow([]))).rejects.toThrow(
      TemplateFileError,
    );
    await expect(releaseTemplateFromWorkflow(tempRoot, "demo", "0.5.0", makeEditedWorkflow([]))).rejects.toThrow(
      /当前版本 "1.0.0"/,
    );
  });

  test("同版本已在 versions：拒绝（不可变）", async () => {
    await createDemoTemplate("demo");
    // 手工构造：versions 预占未来版本 1.5.0（合法非当前），发布该版本命中「已存在」分支
    const templateJsonPath = join(tempRoot, "demo", "template.json");
    const raw = JSON.parse(await readFile(templateJsonPath, "utf8")) as {
      versions: Array<{ version: string; createdAt: string; changelog: string }>;
    };
    raw.versions.push({ version: "1.5.0", createdAt: "2026-01-01T00:00:00.000Z", changelog: "预占" });
    await writeFile(templateJsonPath, JSON.stringify(raw), "utf8");

    await expect(releaseTemplateFromWorkflow(tempRoot, "demo", "1.5.0", makeEditedWorkflow([]))).rejects.toThrow(
      /版本已存在/,
    );
  });

  test("版本目录已存在：拒绝（不可变）", async () => {
    await createDemoTemplate("demo");
    await mkdir(join(tempRoot, "demo", "v1.0.0"), { recursive: true });
    await expect(releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", makeEditedWorkflow([]))).rejects.toThrow(
      /版本目录已存在/,
    );
  });

  test("模板不存在：抛 TemplateNotFoundError", async () => {
    await expect(releaseTemplateFromWorkflow(tempRoot, "no-such-template", "1.0.0", makeEditedWorkflow([]))).rejects.toThrow(
      TemplateNotFoundError,
    );
  });

  test("不可变：发布后原 v0.1.0/workflow.json 内容不变，新版本内容 = 各次传入 workflow", async () => {
    await createDemoTemplate("demo");
    const original = await readFile(join(tempRoot, "demo", "v0.1.0", "workflow.json"), "utf8");

    await releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", makeEditedWorkflow(["b"]));
    await releaseTemplateFromWorkflow(tempRoot, "demo", "1.1.0", makeEditedWorkflow(["c"]));

    const after = await readFile(join(tempRoot, "demo", "v0.1.0", "workflow.json"), "utf8");
    expect(after).toBe(original); // 原版本不被修改
    const latest = JSON.parse(await readFile(join(tempRoot, "demo", "v1.1.0", "workflow.json"), "utf8")) as unknown;
    expect(latest).toEqual(makeEditedWorkflow(["c"])); // 新版本内容精确等于传入 workflow
  });

  test("changelog 落盘：显式值写入，缺省为「更新」", async () => {
    await createDemoTemplate("demo");
    await releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", makeEditedWorkflow([]), "重大更新：重构处理逻辑");
    await releaseTemplateFromWorkflow(tempRoot, "demo", "1.1.0", makeEditedWorkflow([]));
    const loaded = await loadTemplate(join(tempRoot, "demo"));
    expect(loaded.versions[1]?.changelog).toBe("重大更新：重构处理逻辑");
    expect(loaded.versions[2]?.changelog).toBe("更新");
  });

  test("非法版本号：抛 SemanticVersionError", async () => {
    await createDemoTemplate("demo");
    for (const bad of ["abc", "1.0", "v1.0.0", "1.0.0-alpha"]) {
      await expect(releaseTemplateFromWorkflow(tempRoot, "demo", bad, makeEditedWorkflow([]))).rejects.toThrow(
        SemanticVersionError,
      );
    }
  });

  test("写入失败清理半成品：非法 workflow（binding 格式错误）序列化抛错，不留 v<version> 目录", async () => {
    await createDemoTemplate("demo");
    const edited = makeEditedWorkflow(["x"]);
    const step = edited.nodes[0]!;
    const badWorkflow: Workflow = {
      ...edited,
      nodes: [
        { ...step, inputs: [{ ...step.inputs[0]!, binding: "invalid-binding" }] }, // 无冒号，不满足 "scope:key" 格式
        edited.nodes[1]!,
      ],
    };

    await expect(releaseTemplateFromWorkflow(tempRoot, "demo", "1.0.0", badWorkflow)).rejects.toThrow(/Invalid workflow/);
    expect(await pathExists(join(tempRoot, "demo", "v1.0.0"))).toBe(false); // 半成品目录已清理
  });
});
