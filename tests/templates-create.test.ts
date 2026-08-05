// 模板创建测试（T3）：目录结构 / interface / 命名校验 / 冲突拒绝 / 打包非法透传。
// 临时目录用 opencode 专用 temp，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Edge, Node, Workflow } from "../src/model/types.js";
import { InvalidSubgraphSelectionError } from "../src/subgraph/shared.js";
import { TemplateFileError } from "../src/templates/errors.js";
import {
  createTemplate,
  INITIAL_TEMPLATE_VERSION,
  validateTemplateName,
} from "../src/templates/create.js";
import { loadTemplate } from "../src/templates/load.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\templates-create-test";

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── 构造工作流：start →(data) cmd(in:cmd) →(stdout) sv(in:text) →(result) end ──
// 打包选中 [cmd, sv]：边界入边 in_cmd、边界出边 out_result + 固定 out。

const startNode: Node = {
  id: "start",
  type: "start",
  name: "开始",
  params: {},
  inputs: [],
  outputs: [
    { id: "data", name: "data", type: "any", direction: "out", binding: "workflow:start" },
  ],
};

const cmdNode: Node = {
  id: "cmd",
  type: "command",
  name: "命令执行",
  params: { command: "node", args: ["-e", "console.log('hi')"] },
  inputs: [{ id: "cmd", name: "cmd", type: "any", direction: "in" }],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
};

const svNode: Node = {
  id: "sv",
  type: "setVariable",
  name: "写入变量",
  params: { target: "workflow:y", value: "${workflow:x}+5" },
  inputs: [{ id: "text", name: "text", type: "any", direction: "in" }],
  outputs: [{ id: "result", name: "result", type: "any", direction: "out" }],
};

const endNode: Node = {
  id: "end",
  type: "end",
  name: "结束",
  params: {},
  inputs: [
    { id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" },
  ],
  outputs: [],
};

const edges: readonly Edge[] = [
  { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "cmd", targetPortId: "cmd" },
  { id: "e2", sourceNodeId: "cmd", sourcePortId: "stdout", targetNodeId: "sv", targetPortId: "text" },
  { id: "e3", sourceNodeId: "sv", sourcePortId: "result", targetNodeId: "end", targetPortId: "in" },
];

const workflow: Workflow = {
  id: "tpl-demo",
  name: "模板创建演示",
  version: "0.1.0",
  nodes: [startNode, cmdNode, svNode, endNode],
  edges,
};

describe("createTemplate", () => {
  test("创建模板：template.json 与 v0.1.0/workflow.json 写入，版本记录正确", async () => {
    const template = await createTemplate(TEMP_BASE, "my-template", workflow, ["cmd", "sv"]);
    expect(template.name).toBe("my-template");
    expect(template.currentVersion).toBe(INITIAL_TEMPLATE_VERSION);
    expect(template.versions).toHaveLength(1);
    expect(template.versions[0]?.version).toBe("0.1.0");
    expect(template.versions[0]?.changelog).toBe("初始版本");

    const templatePath = join(TEMP_BASE, "my-template", "template.json");
    const workflowPath = join(TEMP_BASE, "my-template", "v0.1.0", "workflow.json");
    expect(await fileExists(templatePath)).toBe(true);
    expect(await fileExists(workflowPath)).toBe(true);

    // workflow.json 是打包产物：含 id/name/version/nodes/edges
    const parsed = JSON.parse(await readFile(workflowPath, "utf8")) as Record<string, unknown>;
    expect(typeof parsed["id"]).toBe("string");
    expect(typeof parsed["name"]).toBe("string");
    expect(typeof parsed["version"]).toBe("string");
    expect(Array.isArray(parsed["nodes"])).toBe(true);
    expect(Array.isArray(parsed["edges"])).toBe(true);
  });

  test("interface：inputs 去 in_ 前缀、outputs 去 out_ 前缀且含固定 out", async () => {
    const template = await createTemplate(TEMP_BASE, "my-template", workflow, ["cmd", "sv"]);
    expect(template.interface.inputs).toEqual(["cmd"]);
    expect(template.interface.outputs).toEqual(["result", "out"]);
  });

  test("template.json 可被 loadTemplate 读回：字段与接口一致", async () => {
    const created = await createTemplate(TEMP_BASE, "my-template", workflow, ["cmd", "sv"]);
    const loaded = await loadTemplate(join(TEMP_BASE, "my-template"));
    expect(loaded).toEqual(created);
    expect(loaded.currentVersion).toBe("0.1.0");
    expect(loaded.versions[0]?.changelog).toBe("初始版本");
    expect(loaded.interface).toEqual({ inputs: ["cmd"], outputs: ["result", "out"] });
  });

  test("非法名：空 / 含 @ / Windows 非法字符 / 空白 / 段非法 → 抛 TemplateFileError", async () => {
    for (const bad of ["", "a@b", "bad:name", "bad\\name", "a b", "trailing/", "/leading", "a/.."]) {
      await expect(createTemplate(TEMP_BASE, bad, workflow, ["cmd", "sv"])).rejects.toThrow(TemplateFileError);
    }
  });

  test("validateTemplateName：非法抛错、合法返回原值", () => {
    for (const bad of ["", "a@b", "bad:name", "a b", ".."]) {
      expect(() => validateTemplateName(bad)).toThrow(TemplateFileError);
    }
    expect(validateTemplateName("my-template")).toBe("my-template");
  });

  test("目录已存在（含任意内容）→ 冲突拒绝", async () => {
    await mkdir(join(TEMP_BASE, "dup"), { recursive: true });
    await writeFile(join(TEMP_BASE, "dup", "template.json"), "{}", "utf8");
    await expect(createTemplate(TEMP_BASE, "dup", workflow, ["cmd", "sv"])).rejects.toThrow(/已存在/);
    // 无 template.json 的占位目录同样拒绝
    await mkdir(join(TEMP_BASE, "occupied"), { recursive: true });
    await expect(createTemplate(TEMP_BASE, "occupied", workflow, ["cmd", "sv"])).rejects.toThrow(/已存在/);
  });

  test("打包非法：少于 2 节点 / 节点不在图中 → InvalidSubgraphSelectionError 透传", async () => {
    await expect(createTemplate(TEMP_BASE, "tpl", workflow, ["cmd"])).rejects.toThrow(InvalidSubgraphSelectionError);
    await expect(createTemplate(TEMP_BASE, "tpl", workflow, ["cmd", "missing"])).rejects.toThrow(
      InvalidSubgraphSelectionError,
    );
  });
});
