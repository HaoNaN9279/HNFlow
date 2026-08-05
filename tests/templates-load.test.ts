// 模板库加载测试（T1）：scanTemplates / loadTemplate / loadTemplateVersion 覆盖。
// 临时目录用 mkdtemp + 每测试独立子目录，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TemplateFileError, TemplateScanError } from "../src/templates/errors.js";
import { findTemplateByName, loadTemplate, loadTemplateVersion, scanTemplates } from "../src/templates/load.js";

const TEMP_ROOT = await mkdtemp(join(tmpdir(), "hnflow-templates-load-"));
let TEMP_BASE: string;

afterAll(async () => {
  await rmRetry(TEMP_ROOT);
}, 30000);

beforeEach(async () => {
  TEMP_BASE = join(TEMP_ROOT, randomUUID());
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

/** 写入相对 TEMP_BASE 的文件（"/" 分隔，自动建父目录）。 */
async function writeFileRel(relPath: string, content: string): Promise<void> {
  const filePath = join(TEMP_BASE, ...relPath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function templateJson(name: string, currentVersion = "0.1.0"): string {
  return JSON.stringify({
    name,
    description: `${name} 模板`,
    versions: [{ version: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z", changelog: "初始版本" }],
    currentVersion,
    interface: { inputs: ["prompt"], outputs: ["result"] },
  });
}

function workflowJson(): string {
  return JSON.stringify({
    id: "wf-tpl-1",
    name: "模板工作流",
    version: "0.1.0",
    nodes: [],
    edges: [],
  });
}

describe("scanTemplates", () => {
  test("标准模板目录结构：template.json + v0.1.0/workflow.json → 命中", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));
    await writeFileRel("alpha/v0.1.0/workflow.json", workflowJson());

    const templates = await scanTemplates(TEMP_BASE);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe("alpha");
    expect(templates[0]?.versions).toHaveLength(1);
    expect(templates[0]?.versions[0]?.version).toBe("0.1.0");
  });

  test("无 template.json 的目录跳过；多层嵌套扫描命中", async () => {
    await writeFileRel("cat/empty/note.txt", "不是模板");
    await writeFileRel("cat/beta/template.json", templateJson("beta"));
    await writeFileRel("x/y/z/gamma/template.json", templateJson("gamma"));

    const templates = await scanTemplates(TEMP_BASE);
    expect(templates.map((t) => t.name)).toEqual(["beta", "gamma"]); // 按 name 字典序
  });

  test("损坏 template.json：警告跳过不中断其他模板", async () => {
    await writeFileRel("broken/template.json", "{ 不是合法 JSON !");
    await writeFileRel("good/template.json", templateJson("good"));

    const warn = spyOn(console, "warn");
    try {
      const templates = await scanTemplates(TEMP_BASE);
      expect(templates.map((t) => t.name)).toEqual(["good"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("rootDir 不存在：抛 TemplateScanError", async () => {
    await expect(scanTemplates(join(TEMP_BASE, "no-such-dir"))).rejects.toBeInstanceOf(TemplateScanError);
  });
});

describe("loadTemplate", () => {
  test("currentVersion 不在 versions：抛 TemplateFileError", async () => {
    await writeFileRel("bad/template.json", templateJson("bad", "9.9.9"));
    await expect(loadTemplate(join(TEMP_BASE, "bad"))).rejects.toBeInstanceOf(TemplateFileError);
  });

  test("interface 字段完整读取：inputs/outputs 与配置一致", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));
    const template = await loadTemplate(join(TEMP_BASE, "alpha"));
    expect(template.interface).toEqual({ inputs: ["prompt"], outputs: ["result"] });
  });

  test("findTemplateByName 命中与未命中", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));
    await expect(findTemplateByName(TEMP_BASE, "alpha")).resolves.toMatchObject({ name: "alpha" });
    await expect(findTemplateByName(TEMP_BASE, "missing")).resolves.toBeUndefined();
  });
});

describe("loadTemplateVersion", () => {
  test("正常版本：返回校验通过的子工作流", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));
    await writeFileRel("alpha/v0.1.0/workflow.json", workflowJson());

    const template = await loadTemplate(join(TEMP_BASE, "alpha"));
    const workflow = await loadTemplateVersion(join(TEMP_BASE, "alpha"), template, "0.1.0");
    expect(workflow).toBeDefined();
    expect(workflow?.id).toBe("wf-tpl-1");
    expect(workflow?.nodes).toEqual([]);
  });

  test("版本不在 versions 中：返回 undefined", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));
    await writeFileRel("alpha/v0.1.0/workflow.json", workflowJson());

    const template = await loadTemplate(join(TEMP_BASE, "alpha"));
    await expect(loadTemplateVersion(join(TEMP_BASE, "alpha"), template, "9.9.9")).resolves.toBeUndefined();
  });

  test("workflow.json 非法（缺 nodes）：抛 TemplateFileError", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));
    await writeFileRel("alpha/v0.1.0/workflow.json", JSON.stringify({ id: "x", name: "x", version: "0.1.0", edges: [] }));

    const template = await loadTemplate(join(TEMP_BASE, "alpha"));
    await expect(loadTemplateVersion(join(TEMP_BASE, "alpha"), template, "0.1.0")).rejects.toBeInstanceOf(
      TemplateFileError,
    );
  });

  test("workflow.json 文件缺失：抛 TemplateFileError", async () => {
    await writeFileRel("alpha/template.json", templateJson("alpha"));

    const template = await loadTemplate(join(TEMP_BASE, "alpha"));
    await expect(loadTemplateVersion(join(TEMP_BASE, "alpha"), template, "0.1.0")).rejects.toBeInstanceOf(
      TemplateFileError,
    );
  });
});
