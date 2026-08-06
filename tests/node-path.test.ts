// 节点路径格式化（v0.4.2 验收 5）单测 + Engine 失败日志 nodePath 注入集成测试。
import { describe, expect, test } from "bun:test";
import type { INodeDefinition } from "../src/execution/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { formatNodePath, PATH_SEPARATOR } from "../src/execution/node-path.js";
import type { Node, Workflow } from "../src/model/types.js";
import { builtinNodes, NodeRegistry, registry } from "../src/nodes/registry.js";

function namedNode(id: string, type: string, name: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name, params, inputs: def.inputs, outputs: def.outputs };
}

function makeSubworkflowNode(id: string, name: string, subWorkflow: Workflow): Node {
  return {
    id,
    type: "subworkflow",
    name,
    params: { subworkflow: subWorkflow },
    inputs: [],
    outputs: [{ id: "out", name: "结果", type: "any", direction: "out" }],
  };
}

/** 失败节点：执行即抛错（node:error 日志触发点）。 */
const boomDef: INodeDefinition = {
  type: "boom",
  name: "boom",
  inputs: [],
  outputs: [],
  async execute(): Promise<Record<string, unknown>> {
    throw new Error("boom exploded");
  },
};

const boomRegistry = new NodeRegistry();
for (const def of builtinNodes) boomRegistry.register(def);
boomRegistry.register(boomDef);

describe("formatNodePath 单元测试", () => {
  const names: Readonly<Record<string, string>> = {
    sub1: "发布子流程",
    sub2: "资源准备",
    import: "资源导入",
  };
  const resolve = (id: string): string | undefined => names[id];

  test("顶层单节点：workflowId 单段（根）→ 顶层工作流 > 节点名", () => {
    expect(formatNodePath("wf-root", "import", resolve)).toBe("顶层工作流 > 资源导入");
  });

  test("两级：root:容器节点 → 顶层工作流 > 容器名 > 节点名（验收示例格式）", () => {
    expect(formatNodePath("wf-root:sub1", "import", resolve)).toBe("顶层工作流 > 发布子流程 > 资源导入");
  });

  test("三级：root:sub1:sub2 → 顶层工作流 > 容器1名 > 容器2名 > 节点名", () => {
    expect(formatNodePath("wf-root:sub1:sub2", "import", resolve)).toBe("顶层工作流 > 发布子流程 > 资源准备 > 资源导入");
  });

  test("未知 id 回退原始 id（容器段与节点段均回退）", () => {
    expect(formatNodePath("wf-root:ghost", "import", resolve)).toBe("顶层工作流 > ghost > 资源导入");
    expect(formatNodePath("wf-root", "ghost", resolve)).toBe("顶层工作流 > ghost");
  });

  test("空 workflowId：无容器段 → 顶层工作流 > 节点名", () => {
    expect(formatNodePath("", "import", resolve)).toBe("顶层工作流 > 资源导入");
  });

  test("PATH_SEPARATOR 常量导出", () => {
    expect(PATH_SEPARATOR).toBe(" > ");
  });
});

describe("Engine 失败日志 nodePath 注入", () => {
  test("顶层引擎失败：日志 data.nodePath = 顶层工作流 > 节点名", async () => {
    const workflow: Workflow = {
      id: "wf-root",
      name: "根工作流",
      version: "0.1.0",
      nodes: [
        namedNode("start", "start", "开始"),
        { id: "import", type: "boom", name: "资源导入", params: {}, inputs: [], outputs: [] },
        namedNode("end", "end", "结束"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "import", targetPortId: "in" },
        { id: "e2", sourceNodeId: "import", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(workflow, { registry: boomRegistry });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    const errorLog = engine.logs.find((entry) => entry.message.startsWith("node:error import:"));
    if (errorLog === undefined) throw new Error("missing node:error import log");
    const data = errorLog.data as { readonly status?: string; readonly nodePath?: string };
    expect(data.status).toBe("Failed");
    expect(data.nodePath).toBe("顶层工作流 > 资源导入");
  });

  test("子引擎（workflowId 为父链）：日志 data.nodePath = 顶层工作流 > 容器id > 节点名", async () => {
    // 模拟子引擎：workflow.id = 父workflowId:容器节点id（subgraph-exec 构造子引擎时覆盖 workflow.id）。
    // 容器节点属父图、子引擎 #nodeById 查不到其名字 → 回退原始 id；叶子节点名可解析。
    const subWorkflow: Workflow = {
      id: "wf-root:publish",
      name: "发布子流程",
      version: "0.1.0",
      nodes: [
        namedNode("start", "start", "开始"),
        { id: "import", type: "boom", name: "资源导入", params: {}, inputs: [], outputs: [] },
      ],
      edges: [
        { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "import", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(subWorkflow, { registry: boomRegistry });
    const result = await engine.run();
    expect(result.status).toBe("failed");
    const errorLog = engine.logs.find((entry) => entry.message.startsWith("node:error import:"));
    if (errorLog === undefined) throw new Error("missing node:error import log");
    const data = errorLog.data as { readonly nodePath?: string };
    expect(data.nodePath).toBe("顶层工作流 > publish > 资源导入");
  });

  test("真实子工作流容器失败：父引擎容器日志 data.nodePath = 顶层工作流 > 容器名", async () => {
    const sub: Workflow = {
      id: "sub",
      name: "子工作流",
      version: "0.1.0",
      nodes: [
        namedNode("start", "start", "开始"),
        namedNode("cmd", "command", "资源导入", {
          command: "node",
          args: ["-e", "process.exit(1)"],
          failOnNonZero: true,
        }),
        namedNode("end", "end", "结束"),
      ],
      edges: [],
    };
    const parent: Workflow = {
      id: "wf-root",
      name: "根工作流",
      version: "0.1.0",
      nodes: [
        namedNode("start", "start", "开始"),
        makeSubworkflowNode("publish", "发布子流程", sub),
        namedNode("end", "end", "结束"),
      ],
      edges: [
        { id: "e3", sourceNodeId: "publish", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
      ],
    };
    const engine = new ExecutionEngine(parent);
    const result = await engine.run();
    expect(result.status).toBe("failed");
    expect(result.nodeStates["publish"]).toBe("Failed");
    const errorLog = engine.logs.find((entry) => entry.message.startsWith("node:error publish:"));
    if (errorLog === undefined) throw new Error("missing node:error publish log");
    const data = errorLog.data as { readonly nodePath?: string };
    expect(data.nodePath).toBe("顶层工作流 > 发布子流程");
  });
});
