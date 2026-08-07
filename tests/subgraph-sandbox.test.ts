// 子图沙箱（v0.9.4）：父引擎配置 sandboxRootDir 时子引擎按同样配置约束 file 节点——子图内逃逸路径必须拒绝（Momus 阻塞点 2 验证）。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEngine } from "../src/execution/Engine.js";
import type { Node, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode";

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function makeSubworkflowNode(id: string, subWorkflow: Workflow): Node {
  return {
    id,
    type: "subworkflow",
    name: "子工作流",
    params: { subworkflow: subWorkflow },
    inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

const tmpBases: string[] = [];

async function makeSandbox(prefix: string): Promise<{ readonly base: string; readonly sandbox: string }> {
  const base = await mkdtemp(join(TEMP_BASE, prefix));
  tmpBases.push(base);
  const sandbox = join(base, "sandbox");
  await mkdir(sandbox, { recursive: true });
  return { base, sandbox };
}

afterAll(async () => {
  await Promise.all(tmpBases.map((path) => rm(path, { recursive: true, force: true })));
});

describe("子图沙箱透传", () => {
  test("父引擎沙箱配置 → 子图内 file 逃逸路径抛错（failed 且错误含沙箱消息）", async () => {
    const { sandbox } = await makeSandbox("hnflow-sub-sb-esc-");
    const sub: Workflow = {
      id: "sub-esc",
      name: "子图",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("f", "file", { operation: "write", path: "../escaped.txt", content: "evil" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "parent-esc",
      name: "父",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent, { sandboxRootDir: sandbox }).run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("路径逃逸沙箱");
  });

  test("父引擎沙箱配置 → 子图内 file 沙箱内路径放行（success）", async () => {
    const { sandbox } = await makeSandbox("hnflow-sub-sb-ok-");
    const sub: Workflow = {
      id: "sub-ok",
      name: "子图",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeNode("f", "file", { operation: "write", path: "inside.txt", content: "ok" }),
        makeNode("end", "end"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "parent-ok",
      name: "父",
      version: "0.1.0",
      nodes: [
        makeNode("start", "start"),
        makeSubworkflowNode("sub", sub),
        makeNode("end", "end"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "sub", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const result = await new ExecutionEngine(parent, { sandboxRootDir: sandbox }).run();
    expect(result.status).toBe("success");
  });
});
