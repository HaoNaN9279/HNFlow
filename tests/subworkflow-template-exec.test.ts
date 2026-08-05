// subworkflow 节点模板引用执行测试（T2）：params.template（"name@version"）→ 加载模板库工作流执行。
// 覆盖：成功执行、模板缺失、版本缺失、非法引用、内嵌回归、嵌套透传、Engine 缺省。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Port, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import { TemplateNotFoundError } from "../src/templates/errors.js";
import { loadTemplateWorkflow, parseTemplateRef } from "../src/templates/load-template-workflow.js";

const TEMP_ROOT = await mkdtemp(join(tmpdir(), "hnflow-subwf-template-"));
let TEMP_BASE: string;

afterAll(async () => { await rmRetry(TEMP_ROOT); }, 30000);

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
        Bun.gc(true);
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

function templateJson(name: string): string {
  return JSON.stringify({
    name, description: `${name} 模板`,
    versions: [{ version: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z", changelog: "初始版本" }],
    currentVersion: "0.1.0", interface: { inputs: ["msg"], outputs: ["result"] },
  });
}

/** demo 模板工作流：内部 setVariable 读 workflow:params:msg 写 endInput → end 输出。 */
function demoWorkflowJson(): string {
  return JSON.stringify({
    id: "demo-tpl", name: "demo 模板", version: "0.1.0",
    nodes: [
      { id: "start", type: "start", name: "开始", params: {}, inputs: [], outputs: [{ id: "data", name: "data", type: "any", direction: "out", binding: "workflow:start" }] },
      { id: "sv", type: "setVariable", name: "变量赋值", params: { target: "workflow:endInput", value: "${workflow:params:msg}" }, inputs: [], outputs: [] },
      { id: "end", type: "end", name: "结束", params: {}, inputs: [{ id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" }], outputs: [] },
    ],
    edges: [],
  });
}

async function writeDemoTemplate(): Promise<void> {
  await writeFileRel("demo/template.json", templateJson("demo"));
  await writeFileRel("demo/v0.1.0/workflow.json", demoWorkflowJson());
}

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeSubNode(id: string, params: Readonly<Record<string, unknown>>, inputPorts: readonly Port[] = []): Node {
  return {
    id, type: "subworkflow", name: "子工作流", params,
    inputs: [...inputPorts],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

function makeParent(id: string, sub: Node): Workflow {
  return {
    id, name: "parent", version: "0.1.0",
    nodes: [makeNode("start", "start"), sub, makeNode("end", "end")],
    edges: [{ id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }],
  };
}

function inlineSubWorkflow(id: string, value: string): Workflow {
  return {
    id, name: "内嵌子工作流", version: "0.1.0",
    nodes: [makeNode("start", "start"), makeNode("sv", "setVariable", { target: "workflow:endInput", value }), makeNode("end", "end")],
    edges: [],
  };
}

describe("parseTemplateRef", () => {
  test("name@version 正常解析；多 @ 取最后", () => {
    expect(parseTemplateRef("demo@0.1.0")).toEqual({ name: "demo", version: "0.1.0" });
    expect(parseTemplateRef("a@b@0.1.0")).toEqual({ name: "a@b", version: "0.1.0" });
  });

  test("无 @ / @ 开头 / @ 结尾 → undefined", () => {
    expect(parseTemplateRef("noversion")).toBeUndefined();
    expect(parseTemplateRef("@0.1.0")).toBeUndefined();
    expect(parseTemplateRef("demo@")).toBeUndefined();
  });
});

describe("loadTemplateWorkflow", () => {
  test("有效引用：返回校验通过的模板工作流", async () => {
    await writeDemoTemplate();
    const workflow = await loadTemplateWorkflow(TEMP_BASE, "demo@0.1.0");
    expect(workflow.id).toBe("demo-tpl");
    expect(workflow.nodes.map((node) => node.type)).toEqual(["start", "setVariable", "end"]);
  });

  test("模板不存在：抛 TemplateNotFoundError 且消息含引用", async () => {
    await expect(loadTemplateWorkflow(TEMP_BASE, "demo@0.1.0")).rejects.toThrow(TemplateNotFoundError);
    await expect(loadTemplateWorkflow(TEMP_BASE, "demo@0.1.0")).rejects.toThrow(/demo@0\.1\.0/);
  });

  test("版本不存在：抛 TemplateNotFoundError 且消息含引用与可用版本", async () => {
    await writeDemoTemplate();
    await expect(loadTemplateWorkflow(TEMP_BASE, "demo@9.9.9")).rejects.toThrow(/demo@9\.9\.9/);
    await expect(loadTemplateWorkflow(TEMP_BASE, "demo@9.9.9")).rejects.toThrow(/0\.1\.0/);
  });

  test("非法引用：抛 TemplateNotFoundError 且消息含引用", async () => {
    await expect(loadTemplateWorkflow(TEMP_BASE, "noversion")).rejects.toThrow(/noversion/);
    await expect(loadTemplateWorkflow(TEMP_BASE, "x@")).rejects.toThrow(/x@/);
  });
});

describe("subworkflow template 集成", () => {
  test("template 引用成功：参数绑定 → 子图插值 → out 正确", async () => {
    await writeDemoTemplate();
    const parent: Workflow = {
      id: "parent-template", name: "parent", version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:params:msg", value: "hello template" }),
        makeSubNode("sub", { template: "demo@0.1.0" }, [{ id: "p_msg", name: "消息", type: "any", direction: "in", binding: "workflow:params:msg" }]),
        makeNode("end", "end"),
      ],
      edges: [{ id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }],
    };
    const result = await new ExecutionEngine(parent, { templatesRootDir: TEMP_BASE }).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("hello template");
  });

  test("模板引用缺失：节点 Failed 且错误含引用", async () => {
    await writeFileRel("other/template.json", templateJson("other"));
    const result = await new ExecutionEngine(makeParent("parent-missing", makeSubNode("sub", { template: "demo@0.1.0" })), { templatesRootDir: TEMP_BASE }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["sub"]).toBe("Failed");
    if (result.error === undefined) throw new Error("expected error message");
    expect(result.error).toContain("demo@0.1.0");
  });

  test("版本不存在：Failed 且错误含引用与可用版本", async () => {
    await writeDemoTemplate();
    const result = await new ExecutionEngine(makeParent("parent-version", makeSubNode("sub", { template: "demo@9.9.9" })), { templatesRootDir: TEMP_BASE }).run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["sub"]).toBe("Failed");
    if (result.error === undefined) throw new Error("expected error message");
    expect(result.error).toContain("demo@9.9.9");
    expect(result.error).toContain("0.1.0");
  });

  test("非法引用格式（无 @ / 结尾 @）：Failed 且错误含引用", async () => {
    for (const ref of ["noversion", "x@"]) {
      const result = await new ExecutionEngine(makeParent("parent-ref", makeSubNode("sub", { template: ref })), { templatesRootDir: TEMP_BASE }).run();
      expect(result.status).toBe("failed");
      expect(result.nodeStates["sub"]).toBe("Failed");
      if (result.error === undefined) throw new Error("expected error message");
      expect(result.error).toContain(ref);
    }
  });

  test("嵌套透传：内嵌子图内 template 引用加载成功", async () => {
    await writeDemoTemplate();
    const inner: Workflow = {
      id: "inner", name: "inner", version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubNode("subTpl", { template: "demo@0.1.0" }, [{ id: "p_msg", name: "消息", type: "any", direction: "in", binding: "workflow:params:msg" }]),
        makeNode("end", "end"),
      ],
      edges: [{ id: "e3", sourceNodeId: "subTpl", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }],
    };
    const parent: Workflow = {
      id: "parent-nested", name: "parent", version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("sv", "setVariable", { target: "workflow:params:msg", value: "hello nested" }),
        makeSubNode("sub", { subworkflow: inner }, [{ id: "p_msg", name: "消息", type: "any", direction: "in", binding: "workflow:params:msg" }]),
        makeNode("end", "end"),
      ],
      edges: [{ id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" }],
    };
    const result = await new ExecutionEngine(parent, { templatesRootDir: TEMP_BASE }).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("hello nested");
  });

  test("无 template 引用（内嵌对象）：行为不变，空模板目录零 IO", async () => {
    const result = await new ExecutionEngine(makeParent("parent-inline", makeSubNode("sub", { subworkflow: inlineSubWorkflow("sub-inline", "final") })), { templatesRootDir: TEMP_BASE }).run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("final");
  });

  test("Engine 缺省 templatesRootDir：构造不抛错，内嵌子图正常执行", async () => {
    const engine = new ExecutionEngine(makeParent("parent-default", makeSubNode("sub", { subworkflow: inlineSubWorkflow("sub-default", "ok") })));
    expect(engine).toBeDefined();
    const result = await engine.run();
    expect(result.status).toBe("success");
    expect(result.nodeOutputs["sub"]?.["out"]).toBe("ok");
  });
});
