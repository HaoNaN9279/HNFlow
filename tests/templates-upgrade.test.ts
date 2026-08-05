// 模板引用升级测试（T4）：upgradeTemplateRefs 门槛过滤 + D7 端口校验后更新引用版本。
// 临时目录用 opencode 专用 temp + 随机后缀，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { upgradeTemplateRefs, type TemplateUpgradedEntry } from "../src/templates/upgrade.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-templates-upgrade-${randomUUID()}`);

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

/** 写入模板元数据：currentVersion = 最后一个版本，interface 可控（端口校验基准 = 最新版本 interface）。 */
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

/** 构造端口与 interface { inputs:["a"], outputs:["result"] } 匹配的引用节点（含固定 out 输出）。 */
function matchingNode(id: string, name: string, template: string, subworkflow?: Workflow): Node {
  return {
    id,
    type: "subworkflow",
    name,
    params: { template },
    inputs: [{ id: "in_a", name: "参数a", type: "any", direction: "in" }],
    outputs: [
      { id: "out_result", name: "结果", type: "any", direction: "out" },
      { id: "out", name: "固定输出", type: "any", direction: "out" },
    ],
    ...(subworkflow === undefined ? {} : { subworkflow }),
  };
}

function findByName(entries: readonly TemplateUpgradedEntry[], name: string): TemplateUpgradedEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

describe("upgradeTemplateRefs", () => {
  test("正面用例：端口匹配 → 升级成功（interface 与父节点端口匹配）", async () => {
    await writeTemplate("alpha", ["0.1.0", "1.0.0"], { inputs: ["a"], outputs: ["result"] });
    const workflow = makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0")]);

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { allowMajor: true });
    expect(result.upgraded).toEqual([
      { name: "alpha", nodePath: "sub-1 (子工作流)", from: "0.1.0", to: "1.0.0", diff: "major" },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.workflow.nodes[0]?.params["template"]).toBe("alpha@1.0.0");
    expect(result.workflow).not.toBe(workflow);
  });

  test("反面用例：最新版本 interface.inputs 含父节点缺失端口 → 跳过并计入 skipped", async () => {
    await writeTemplate("alpha", ["0.1.0", "1.0.0"], { inputs: ["a", "new_param"], outputs: ["result"] });
    const workflow = makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0")]); // 无 in_new_param

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { allowMajor: true });
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "alpha", nodePath: "sub-1 (子工作流)", from: "0.1.0", to: "1.0.0", diff: "major" },
    ]);
    expect(result.workflow).toBe(workflow);
  });

  test("反面：父节点 outputs 含 out_extra 但 interface.outputs 无 extra → 跳过", async () => {
    await writeTemplate("alpha", ["0.1.0", "1.0.0"], { inputs: ["a"], outputs: ["result"] });
    const node: Node = {
      id: "sub-1",
      type: "subworkflow",
      name: "子工作流",
      params: { template: "alpha@0.1.0" },
      inputs: [{ id: "in_a", name: "参数a", type: "any", direction: "in" }],
      outputs: [
        { id: "out_extra", name: "多余输出", type: "any", direction: "out" },
        { id: "out", name: "固定输出", type: "any", direction: "out" },
      ],
    };
    const workflow = makeWorkflow([node]);

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { allowMajor: true });
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(findByName(result.skipped, "alpha")?.to).toBe("1.0.0");
    expect(result.workflow).toBe(workflow);
  });

  test("门槛：autoPatch 默认 false → patch 不升级；allowMinor/allowMajor 生效", async () => {
    await writeTemplate("t-patch", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    await writeTemplate("t-minor", ["0.1.0", "0.2.0"], { inputs: ["a"], outputs: ["result"] });
    await writeTemplate("t-major", ["0.1.0", "1.0.0"], { inputs: ["a"], outputs: ["result"] });
    const workflow = makeWorkflow([
      matchingNode("n1", "节点1", "t-patch@0.1.0"),
      matchingNode("n2", "节点2", "t-minor@0.1.0"),
      matchingNode("n3", "节点3", "t-major@0.1.0"),
    ]);

    // 默认门槛全关：patch/minor/major 都不升，原引用返回
    const blocked = await upgradeTemplateRefs(TEMP_BASE, workflow);
    expect(blocked.upgraded).toEqual([]);
    expect(blocked.workflow).toBe(workflow);

    // autoPatch：仅 patch 升级
    const patched = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true });
    expect(patched.upgraded.map((entry) => entry.name)).toEqual(["t-patch"]);
    expect(patched.workflow.nodes[0]?.params["template"]).toBe("t-patch@0.1.1");

    // autoPatch + allowMinor：patch + minor 升级
    const withMinor = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true, allowMinor: true });
    expect(withMinor.upgraded.map((entry) => entry.name).sort()).toEqual(["t-minor", "t-patch"]);

    // 全开：三项都升级
    const all = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true, allowMinor: true, allowMajor: true });
    expect(all.upgraded).toHaveLength(3);
    expect(findByName(all.upgraded, "t-major")?.to).toBe("1.0.0");
  });

  test("无升级 → 返回原引用（toBe 同一对象）+ 空数组", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: ["a"], outputs: ["result"] });
    const workflow = makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0")]);

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true, allowMajor: true });
    expect(result.workflow).toBe(workflow);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("更新后其余未涉及节点不变（深拷贝隔离 + 原引用未被修改）", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    await writeTemplate("beta", ["0.1.0"], { inputs: ["a"], outputs: ["result"] }); // 已最新
    const workflow = makeWorkflow([
      matchingNode("sub-1", "子工作流", "alpha@0.1.0"),
      matchingNode("sub-2", "子工作流", "beta@0.1.0"),
    ]);

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true });
    expect(result.upgraded).toHaveLength(1);
    expect(result.workflow.nodes[0]?.params["template"]).toBe("alpha@0.1.1");
    expect(result.workflow.nodes[1]?.params["template"]).toBe("beta@0.1.0"); // 未涉及不变
    // 不可变风格：原 workflow 未被修改
    expect(workflow.nodes[0]?.params["template"]).toBe("alpha@0.1.0");
    expect(workflow.nodes[1]?.params["template"]).toBe("beta@0.1.0");
  });

  test("嵌套 subworkflow：子图引用也被升级", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    await writeTemplate("beta", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    const inner = makeWorkflow([matchingNode("inner", "内部节点", "beta@0.1.0")]);
    const workflow = makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0", inner)]);

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true });
    expect(result.upgraded).toHaveLength(2);
    expect(result.workflow.nodes[0]?.params["template"]).toBe("alpha@0.1.1");
    expect(result.workflow.nodes[0]?.subworkflow?.nodes[0]?.params["template"]).toBe("beta@0.1.1");
  });

  test("ignores 透传：命中锁定版本的项目被忽略不升级", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    const workflow = makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0")]);

    const result = await upgradeTemplateRefs(TEMP_BASE, workflow, { autoPatch: true, ignores: ["alpha@0.1.0"] });
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.workflow).toBe(workflow);
  });
});
