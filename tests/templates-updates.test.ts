// 模板版本通知测试（T4）：checkTemplateUpdates 对比工作流模板引用与 currentVersion 输出可升级列表。
// 临时目录用 opencode 专用 temp + 随机后缀，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkTemplateUpdates, type TemplateUpdateEntry } from "../src/templates/updates.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-templates-updates-${randomUUID()}`);

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

/** 写入模板元数据：currentVersion = 最后一个版本，interface 可控（updates 只读 template.json）。 */
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

/** 构造模板引用节点（updates 场景无需端口）。 */
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

/** 按模板名在报告条目中查找（不依赖排序）。 */
function findByName(entries: readonly TemplateUpdateEntry[], name: string): TemplateUpdateEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

describe("checkTemplateUpdates", () => {
  test("有模板引用且最新版更高 → entries 含 name/locked/latest/diff", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["out"] });
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0")]);

    const report = await checkTemplateUpdates(TEMP_BASE, workflow);
    expect(report.ignoredCount).toBe(0);
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0];
    expect(entry?.name).toBe("alpha");
    expect(entry?.nodePath).toBe("sub-1 (子工作流)");
    expect(entry?.lockedVersion).toBe("0.1.0");
    expect(entry?.latestVersion).toBe("0.1.1");
    expect(entry?.diff).toBe("patch");
  });

  test("嵌套 subworkflow 内引用 → nodePath 含父链", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: [], outputs: [] });
    await writeTemplate("beta", ["0.1.0", "0.1.1"], { inputs: [], outputs: [] });
    const inner = makeWorkflow([refNode("inner", "内部节点", "beta@0.1.0")]);
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0", inner)]);

    const report = await checkTemplateUpdates(TEMP_BASE, workflow);
    expect(report.entries).toHaveLength(2);
    expect(report.entries.map((entry) => entry.nodePath).sort()).toEqual([
      "sub-1 (子工作流)",
      "sub-1 (子工作流) → inner (内部节点)",
    ]);
  });

  test("ignores 精确匹配跳过并计入 ignoredCount；版本不匹配不误判", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0")]);

    // 精确匹配 "name@lockedVersion"：跳过并计入 ignoredCount
    const ignored = await checkTemplateUpdates(TEMP_BASE, workflow, { ignores: ["alpha@0.1.0"] });
    expect(ignored.entries).toEqual([]);
    expect(ignored.ignoredCount).toBe(1);

    // 版本不匹配锁定版本（写成最新版本）：不忽略，仍进入 entries
    const notIgnored = await checkTemplateUpdates(TEMP_BASE, workflow, { ignores: ["alpha@0.1.1"] });
    expect(notIgnored.entries).toHaveLength(1);
    expect(notIgnored.entries[0]?.diff).toBe("patch");
    expect(notIgnored.ignoredCount).toBe(0);
  });

  test("无效引用 / 模板不存在：跳过不抛错", async () => {
    await writeTemplate("alpha", ["0.1.0", "0.1.1"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([
      refNode("bad-1", "缺版本", "alpha@"),
      refNode("bad-2", "缺名称", "@0.1.0"),
      refNode("bad-3", "模板不存在", "missing@0.1.0"),
      refNode("ok-1", "正常", "alpha@0.1.0"),
    ]);

    const report = await checkTemplateUpdates(TEMP_BASE, workflow);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.nodePath).toBe("ok-1 (正常)");
    expect(report.ignoredCount).toBe(0);
  });

  test("已最新（locked=latest）→ 无 entries", async () => {
    await writeTemplate("alpha", ["0.1.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([refNode("sub-1", "子工作流", "alpha@0.1.0")]);

    const report = await checkTemplateUpdates(TEMP_BASE, workflow);
    expect(report.entries).toEqual([]);
    expect(report.ignoredCount).toBe(0);
  });

  test("diff 分类正确（patch/minor/major）", async () => {
    await writeTemplate("t-patch", ["0.1.0", "0.1.1"], { inputs: [], outputs: [] });
    await writeTemplate("t-minor", ["0.1.0", "0.2.0"], { inputs: [], outputs: [] });
    await writeTemplate("t-major", ["0.1.0", "1.0.0"], { inputs: [], outputs: [] });
    const workflow = makeWorkflow([
      refNode("n1", "节点1", "t-patch@0.1.0"),
      refNode("n2", "节点2", "t-minor@0.1.0"),
      refNode("n3", "节点3", "t-major@0.1.0"),
    ]);

    const report = await checkTemplateUpdates(TEMP_BASE, workflow);
    expect(report.entries).toHaveLength(3);
    expect(findByName(report.entries, "t-patch")?.diff).toBe("patch");
    expect(findByName(report.entries, "t-minor")?.diff).toBe("minor");
    expect(findByName(report.entries, "t-major")?.diff).toBe("major");
  });
});
