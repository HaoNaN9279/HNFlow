// 子工作流模板版本发布测试（v0.3.3 T5）：releaseTemplate 全流程覆盖。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
// T3 已落地，直接用 createTemplate 构造初始模板；interface 为模板顶层字段。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SemanticVersionError } from "../src/groups/errors.js";
import type { Workflow } from "../src/model/types.js";
import { createTemplate } from "../src/templates/create.js";
import { TemplateFileError, TemplateNotFoundError } from "../src/templates/errors.js";
import { loadTemplate } from "../src/templates/load.js";
import { releaseTemplate } from "../src/templates/release.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\templates-release-test";

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
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

/** 用 T3 createTemplate 构造初始模板（v0.1.0，interface.inputs=["a"]）。 */
async function createDemoTemplate(name: string): Promise<void> {
  await createTemplate(TEMP_BASE, name, makeSourceWorkflow(), ["step", "end"], "演示模板");
}

/** 修改指定版本 workflow.json 中某节点 input binding 前缀 key（from → to）。 */
async function renameParamBinding(name: string, version: string, from: string, to: string): Promise<void> {
  const filePath = join(TEMP_BASE, name, `v${version}`, "workflow.json");
  const workflow = JSON.parse(await readFile(filePath, "utf8")) as {
    nodes: Array<{ inputs: Array<{ binding?: string }> }>;
  };
  for (const node of workflow.nodes) {
    for (const port of node.inputs) {
      if (port.binding === `workflow:params:${from}`) {
        port.binding = `workflow:params:${to}`;
      }
    }
  }
  await writeFile(filePath, JSON.stringify(workflow), "utf8");
}

describe("releaseTemplate", () => {
  test("v1.0.0 发布：版本目录内容 = 旧版本拷贝，versions 追加，currentVersion 更新", async () => {
    await createDemoTemplate("demo");

    const released = await releaseTemplate(TEMP_BASE, "demo", "1.0.0");
    expect(released.currentVersion).toBe("1.0.0");
    expect(released.versions).toHaveLength(2);
    expect(released.versions[1]?.version).toBe("1.0.0");

    // 不可变快照 = 整体拷贝：新版本目录存在且 workflow.json 内容一致
    const newWorkflowPath = join(TEMP_BASE, "demo", "v1.0.0", "workflow.json");
    expect(await pathExists(newWorkflowPath)).toBe(true);
    const copied = await readFile(newWorkflowPath, "utf8");
    const original = await readFile(join(TEMP_BASE, "demo", "v0.1.0", "workflow.json"), "utf8");
    expect(copied).toBe(original);

    // 读回一致性：release 返回值可被 loadTemplate 原样读回
    const loaded = await loadTemplate(join(TEMP_BASE, "demo"));
    expect(loaded).toEqual(released);
  });

  test("版本不递增（同版本 / 降级）：拒绝且消息含当前版本", async () => {
    await createDemoTemplate("demo");
    await expect(releaseTemplate(TEMP_BASE, "demo", "0.1.0")).rejects.toThrow(TemplateFileError);
    await releaseTemplate(TEMP_BASE, "demo", "1.0.0");
    await expect(releaseTemplate(TEMP_BASE, "demo", "0.5.0")).rejects.toThrow(/当前版本 "1.0.0"/);
  });

  test("同版本已在 versions：拒绝（不可变）", async () => {
    await createDemoTemplate("demo");
    // 手工构造：versions 预占未来版本 1.5.0（合法非当前），release 该版本命中「已存在」分支
    const templateJsonPath = join(TEMP_BASE, "demo", "template.json");
    const raw = JSON.parse(await readFile(templateJsonPath, "utf8")) as {
      currentVersion: string;
      versions: Array<{ version: string; createdAt: string; changelog: string }>;
    };
    raw.versions.push({ version: "1.5.0", createdAt: "2026-01-01T00:00:00.000Z", changelog: "预占" });
    await writeFile(templateJsonPath, JSON.stringify(raw), "utf8");

    await expect(releaseTemplate(TEMP_BASE, "demo", "1.5.0")).rejects.toThrow(/版本已存在/);
  });

  test("版本目录已存在：拒绝（不可变）", async () => {
    await createDemoTemplate("demo");
    await mkdir(join(TEMP_BASE, "demo", "v1.0.0"), { recursive: true });
    await expect(releaseTemplate(TEMP_BASE, "demo", "1.0.0")).rejects.toThrow(/版本目录已存在/);
  });

  test("interface.inputs 重算 + outputs 沿用：binding a→b 后新版本反映 b 且不含 a", async () => {
    await createDemoTemplate("demo"); // interface.inputs=["a"], outputs=["out"]
    await releaseTemplate(TEMP_BASE, "demo", "1.0.0");
    await renameParamBinding("demo", "1.0.0", "a", "b"); // 修改新版本目录 workflow.json

    const released = await releaseTemplate(TEMP_BASE, "demo", "2.0.0");
    expect(released.currentVersion).toBe("2.0.0");
    expect(released.versions).toHaveLength(3);
    expect(released.interface.inputs).toEqual(["b"]); // 反映 b，不含已删的 a
    expect(released.interface.outputs).toEqual(["out"]); // 沿用上一版本值
  });

  test("无上一版本目录：抛错（模板必须至少有一版内容才能发布）", async () => {
    await createDemoTemplate("demo");
    await releaseTemplate(TEMP_BASE, "demo", "1.0.0"); // currentVersion=1.0.0
    await rm(join(TEMP_BASE, "demo", "v1.0.0"), { recursive: true, force: true }); // 删除上一版本目录

    await expect(releaseTemplate(TEMP_BASE, "demo", "2.0.0")).rejects.toThrow(/上一版本目录不存在/);
    expect(await pathExists(join(TEMP_BASE, "demo", "v2.0.0"))).toBe(false); // 未留半成品
  });

  test("非法版本号：抛 SemanticVersionError", async () => {
    await createDemoTemplate("demo");
    for (const bad of ["abc", "1.0", "v1.0.0", "1.0.0-alpha"]) {
      await expect(releaseTemplate(TEMP_BASE, "demo", bad)).rejects.toThrow(SemanticVersionError);
    }
  });

  test("模板不存在：抛 TemplateNotFoundError", async () => {
    await expect(releaseTemplate(TEMP_BASE, "no-such-template", "1.0.0")).rejects.toThrow(TemplateNotFoundError);
  });

  test("changelog 落盘：显式值写入，缺省为「更新」", async () => {
    await createDemoTemplate("demo");
    await releaseTemplate(TEMP_BASE, "demo", "1.0.0", "重大更新：重构处理逻辑");
    await releaseTemplate(TEMP_BASE, "demo", "2.0.0");
    const loaded = await loadTemplate(join(TEMP_BASE, "demo"));
    expect(loaded.versions[1]?.changelog).toBe("重大更新：重构处理逻辑");
    expect(loaded.versions[2]?.changelog).toBe("更新");
  });
});
