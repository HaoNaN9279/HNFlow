// 模板引用存在性校验测试（v0.3.2 T7）：verifyTemplateRefs 批量校验引用，错误含 nodePath/ref/reason；
// saveWorkflow verifyTemplates 钩子拦截缺失引用不落盘。
// 临时目录用 opencode 专用 temp + 随机后缀，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyTemplateRefs, type TemplateRefError } from "../src/templates/verify-refs.js";
import { saveWorkflow } from "../src/storage/index.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-templates-verify-${randomUUID()}`);

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

/** 写入模板元数据：currentVersion = 最后一个版本。 */
async function writeTemplate(
  name: string,
  versions: readonly string[],
  iface: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
): Promise<void> {
  const currentVersion = versions[versions.length - 1];
  if (currentVersion === undefined) throw new Error("versions 不能为空");
  const dir = join(TEMP_BASE, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "template.json"),
    JSON.stringify({
      name,
      description: `${name} 模板`,
      versions: versions.map((version, index) => ({
        version,
        createdAt: `2026-0${index + 1}-01T00:00:00.000Z`,
        changelog: `版本 ${version}`,
      })),
      currentVersion,
      interface: iface,
    }),
    "utf8",
  );
}

function makeWorkflow(nodes: readonly Node[]): Workflow {
  return { id: "wf-1", name: "测试工作流", version: "1.0.0", nodes, edges: [] };
}

/** 构造模板引用节点（verify-refs 场景无需端口）。 */
function refNode(id: string, name: string, template: string, subworkflow?: Workflow): Node {
  return {
    id,
    type: "subworkflow",
    name,
    params: { template },
    inputs: [],
    outputs: [],
    ...(subworkflow === undefined ? {} : { subworkflow }),
  };
}

/** 按 ref 在错误数组中查找（不依赖排序）。 */
function findByRef(errors: readonly TemplateRefError[], ref: string): TemplateRefError | undefined {
  return errors.find((entry) => entry.ref === ref);
}

describe("verifyTemplateRefs", () => {
  test("有效引用 → 空错误", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["out"] });
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0")]);

    const errors = await verifyTemplateRefs(TEMP_BASE, workflow);
    expect(errors).toEqual([]);
  });

  test("无引用 → 空错误", async () => {
    const plain = makeWorkflow([
      { id: "n1", type: "agent", name: "普通节点", params: {}, inputs: [], outputs: [] },
    ]);
    // params.template 非字符串：不收集（防御）。
    const numeric = makeWorkflow([
      { id: "n2", type: "subworkflow", name: "数字引用", params: { template: 42 }, inputs: [], outputs: [] },
    ]);

    expect(await verifyTemplateRefs(TEMP_BASE, makeWorkflow([]))).toEqual([]);
    expect(await verifyTemplateRefs(TEMP_BASE, plain)).toEqual([]);
    expect(await verifyTemplateRefs(TEMP_BASE, numeric)).toEqual([]);
  });

  test("模板不存在 → 错误含 ref + nodePath", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "missing@0.1.0")]);

    const errors = await verifyTemplateRefs(TEMP_BASE, workflow);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.ref).toBe("missing@0.1.0");
    expect(errors[0]?.nodePath).toBe("sub-1 (子工作流)");
    expect(errors[0]?.reason).toBe("模板不存在");
  });

  test("版本不存在 → 错误含可用版本", async () => {
    await writeTemplate("alpha", ["0.1.0", "1.0.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.0.1")]);

    const errors = await verifyTemplateRefs(TEMP_BASE, workflow);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("版本不存在（可用：0.1.0, 1.0.0）");
  });

  test("无效格式（无 @ / 空段）→ 错误", async () => {
    const workflow = makeWorkflow([
      refNode("bad-1", "无版本", "alpha@"),
      refNode("bad-2", "无名称", "@0.1.0"),
      refNode("bad-3", "无分隔符", "x"),
    ]);

    const errors = await verifyTemplateRefs(TEMP_BASE, workflow);
    expect(errors).toHaveLength(3);
    expect(errors.every((entry) => entry.reason === "引用格式非法")).toBe(true);
    expect(findByRef(errors, "alpha@")?.nodePath).toBe("bad-1 (无版本)");
    expect(findByRef(errors, "@0.1.0")?.nodePath).toBe("bad-2 (无名称)");
  });

  test("嵌套 subworkflow 引用缺失 → nodePath 含父链", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: [], outputs: [] });
    const inner = makeWorkflow([refNode("inner", "内部节点", "ghost@0.1.0")]);
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0", inner)]);

    const errors = await verifyTemplateRefs(TEMP_BASE, workflow);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.nodePath).toBe("sub-1 (子工作流) → inner (内部节点)");
    expect(errors[0]?.ref).toBe("ghost@0.1.0");
  });

  test("多引用多错误批量返回（不中断）", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([
      refNode("ok-1", "正常", "alpha@0.1.0"),
      refNode("bad-1", "模板不存在", "missing@0.1.0"),
      refNode("bad-2", "版本不存在", "alpha@9.9.9"),
      refNode("bad-3", "格式非法", "no-at-sign"),
    ]);

    const errors = await verifyTemplateRefs(TEMP_BASE, workflow);
    expect(errors).toHaveLength(3);
    expect(findByRef(errors, "missing@0.1.0")?.reason).toBe("模板不存在");
    expect(findByRef(errors, "alpha@9.9.9")?.reason).toBe("版本不存在（可用：0.1.0）");
    expect(findByRef(errors, "no-at-sign")?.reason).toBe("引用格式非法");
  });

  test("模板根目录缺失：引用全部报模板不存在，不抛错", async () => {
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0")]);
    const errors = await verifyTemplateRefs(join(TEMP_BASE, "no-such-dir"), workflow);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("模板不存在");
  });

  test("saveWorkflow 带 verifyTemplates 钩子：引用缺失 → 抛错不落盘", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([
      refNode("ok-1", "正常", "alpha@0.1.0"),
      refNode("bad-1", "缺失", "missing@0.1.0"),
    ]);
    const wfPath = join(TEMP_BASE, "wf.json");

    await expect(
      saveWorkflow(wfPath, workflow, { verifyTemplates: (wf) => verifyTemplateRefs(TEMP_BASE, wf) }),
    ).rejects.toThrow("模板引用校验失败，未保存");
    await expect(readFile(wfPath, "utf8")).rejects.toThrow(); // 未落盘
  });

  test("saveWorkflow 钩子：引用全部有效 → 正常落盘", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([refNode("ok-1", "正常", "alpha@0.1.0")]);
    const wfPath = join(TEMP_BASE, "wf.json");

    await saveWorkflow(wfPath, workflow, { verifyTemplates: (wf) => verifyTemplateRefs(TEMP_BASE, wf) });
    await expect(readFile(wfPath, "utf8")).resolves.toContain('"template": "alpha@0.1.0"');
  });
});
