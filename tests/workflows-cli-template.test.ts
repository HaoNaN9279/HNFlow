// workflows check/upgrade 模板部分测试（v0.3.2 T7）：--templates 选项、模板表输出、模板引用升级与端口不匹配跳过。
// 直接调 cmdWorkflowsCheck/cmdWorkflowsUpgrade 验证；临时目录用 opencode 专用 temp，Windows 清理惯例（rmRetry + Bun.gc(true)）。
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cmdWorkflowsCheck } from "../src/cli/workflows-check.js";
import { cmdWorkflowsUpgrade } from "../src/cli/workflows-upgrade.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";
import type { Node, Workflow } from "../src/model/types.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-cli-template-${randomUUID()}`);
const TEMPLATES_DIR = join(TEMP_BASE, "tpl"); // --templates 指向的非常规目录（验证参数生效）

let stdout = "";
let stderr = "";
let code = -1;

/** 重置捕获缓冲并执行 workflows check；返回退出码。 */
async function runCheck(args: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return cmdWorkflowsCheck(args);
}

/** 重置捕获缓冲并执行 workflows upgrade；返回退出码。 */
async function runUpgrade(args: readonly string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return cmdWorkflowsUpgrade(args);
}

const originalLog = console.log;
const originalError = console.error;
const originalInfo = console.info;
const originalWarn = console.warn;

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

/** 写入模板元数据（含 interface，upgrade 端口校验基准）。 */
async function writeTemplate(
  dir: string,
  name: string,
  versions: readonly string[],
  iface: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
): Promise<void> {
  const currentVersion = versions[versions.length - 1];
  if (currentVersion === undefined) throw new Error("versions 不能为空");
  const templateDir = join(dir, name);
  await mkdir(templateDir, { recursive: true });
  await writeFile(
    join(templateDir, "template.json"),
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
  return { id: "wf-cli-template", name: "模板 CLI 测试工作流", version: "1.0.0", nodes, edges: [] };
}

/** 构造与 interface { inputs:["a"], outputs:["result"] } 匹配的引用节点（含固定 out 输出）。 */
function matchingNode(id: string, name: string, template: string): Node {
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
  };
}

/** 构造端口不匹配节点（缺 in_a，仅固定输出）。 */
function mismatchedNode(id: string, name: string, template: string): Node {
  return {
    id,
    type: "subworkflow",
    name,
    params: { template },
    inputs: [],
    outputs: [{ id: "out", name: "固定输出", type: "any", direction: "out" }],
  };
}

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rmRetry(TEMP_BASE);
  await mkdir(TEMPLATES_DIR, { recursive: true });
  stdout = "";
  stderr = "";
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  console.info = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.warn = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.info = originalInfo;
  console.warn = originalWarn;
});

describe("workflows check 模板部分", () => {
  test("含模板引用 + 模板有更高版本 → 输出含模板名与 diff（退出 0）", async () => {
    await writeTemplate(TEMPLATES_DIR, "alpha", ["0.1.0", "1.0.0"], { inputs: ["a"], outputs: ["result"] });
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0")]));

    code = await runCheck([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE]);
    expect(code).toBe(0);
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("1.0.0");
    expect(stdout).toContain("major");
  });

  test("无模板引用 → 退出 0（无模板表）", async () => {
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow([]));

    code = await runCheck([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE]);
    expect(code).toBe(0);
    expect(stdout).toContain("没有可升级的功能组/模板");
    expect(stdout).not.toContain("升级类型"); // 无表输出
  });
});

describe("workflows upgrade 模板部分", () => {
  test("upgrade --all：模板升级 → 保存文件 params.template 更新", async () => {
    await writeTemplate(TEMPLATES_DIR, "alpha", ["0.1.0", "1.0.0"], { inputs: ["a"], outputs: ["result"] });
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow([matchingNode("sub-1", "子工作流", "alpha@0.1.0")]));

    code = await runUpgrade([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE, "--all"]);
    expect(code).toBe(0);
    expect(stdout).toContain("alpha@0.1.0 → 1.0.0（major）");
    expect(stdout).toContain("已保存");

    const saved = await loadWorkflow(wfPath);
    expect(saved.nodes[0]?.params["template"]).toBe("alpha@1.0.0");
  });

  test("upgrade：端口不匹配 → skipped 提示（退出 0，不保存）", async () => {
    await writeTemplate(TEMPLATES_DIR, "alpha", ["0.1.0", "1.0.0"], { inputs: ["a", "new_param"], outputs: ["result"] });
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow([mismatchedNode("sub-1", "子工作流", "alpha@0.1.0")]));

    code = await runUpgrade([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE, "--all"]);
    expect(code).toBe(0);
    expect(stdout).toContain("跳过 alpha（端口不匹配）");
    expect(stdout).not.toContain("已保存");

    const saved = await loadWorkflow(wfPath);
    expect(saved.nodes[0]?.params["template"]).toBe("alpha@0.1.0"); // 未保存升级
  });

  test("--templates 指向临时目录生效：check 与 upgrade 均命中模板", async () => {
    await writeTemplate(TEMPLATES_DIR, "beta", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(wfPath, makeWorkflow([matchingNode("sub-1", "子工作流", "beta@0.1.0")]));

    code = await runCheck([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE]);
    expect(code).toBe(0);
    expect(stdout).toContain("beta");
    expect(stdout).toContain("patch");

    code = await runUpgrade([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE, "--patch"]);
    expect(code).toBe(0);
    expect(stdout).toContain("beta@0.1.0 → 0.1.1（patch）");

    const saved = await loadWorkflow(wfPath);
    expect(saved.nodes[0]?.params["template"]).toBe("beta@0.1.1");
  });

  test("upgrade 保存前校验拦截：有可升级项但另有引用缺失 → fail 不落盘", async () => {
    await writeTemplate(TEMPLATES_DIR, "beta", ["0.1.0", "0.1.1"], { inputs: ["a"], outputs: ["result"] });
    const wfPath = join(TEMP_BASE, "wf.json");
    await saveWorkflow(
      wfPath,
      makeWorkflow([
        matchingNode("sub-1", "子工作流", "beta@0.1.0"),
        mismatchedNode("sub-2", "引用缺失", "ghost@0.1.0"),
      ]),
    );

    code = await runUpgrade([wfPath, "--templates", TEMPLATES_DIR, "--groups", TEMP_BASE, "--patch"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("模板引用校验失败，未保存");
    expect(stdout).not.toContain("已保存");

    const saved = await loadWorkflow(wfPath);
    expect(saved.nodes[0]?.params["template"]).toBe("beta@0.1.0"); // 未落盘升级
  });
});
