// HNFlow v0.1.0 示例演示脚本
// 运行方式：bun run examples/demo.ts
//
// 流程：构建完整工作流（start → setVariable → ifElse → 分支 setVariable → end 汇合）
//  → toJSON 序列化 → saveWorkflow/loadWorkflow 保存加载 → ExecutionEngine 执行 → 打印结果。

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { fromJSON, toJSON } from "../src/serialization/index.js";
import { loadWorkflow, saveWorkflow } from "../src/storage/index.js";

// ── 构造辅助：端口（节点定义里多次出现，提取避免重复样板） ───────────────────

interface PortSpec {
  readonly id: string;
  readonly name: string;
  readonly type: PortType;
  readonly direction: PortDirection;
  readonly binding?: string;
}

function makePort(spec: PortSpec): Port {
  return spec.binding === undefined
    ? { id: spec.id, name: spec.name, type: spec.type, direction: spec.direction }
    : { id: spec.id, name: spec.name, type: spec.type, direction: spec.direction, binding: spec.binding };
}

// ── [1] 创建工作流：Node / Edge / Port 构造 ──────────────────────────────────

const startNode: Node = {
  id: "start",
  type: "start",
  name: "开始",
  params: {},
  inputs: [],
  outputs: [
    makePort({ id: "data", name: "data", type: "any", direction: "out", binding: "workflow:start" }),
  ],
};

// setVariable：支持 ${scope:key} 模板插值，读取 global 变量拼接问候语
const setGreetingNode: Node = {
  id: "setGreeting",
  type: "setVariable",
  name: "设置问候语",
  params: {
    target: "workflow:greeting",
    value: "你好 ${global:name}，年龄 ${global:age}",
  },
  inputs: [],
  outputs: [],
};

// ifElse：对 global:age 做 gte 18 判断，结果写 true/false 双输出端口
const ifElseNode: Node = {
  id: "ifElse",
  type: "ifElse",
  name: "年龄判断",
  params: {
    condition: { variable: "global:age", op: "gte", value: 18 },
  },
  inputs: [
    makePort({ id: "in", name: "value", type: "any", direction: "in", binding: "workflow:ifInput" }),
  ],
  outputs: [
    makePort({ id: "true", name: "true", type: "boolean", direction: "out", binding: "workflow:ifTrue" }),
    makePort({ id: "false", name: "false", type: "boolean", direction: "out", binding: "workflow:ifFalse" }),
  ],
};

const setAdultNode: Node = {
  id: "setAdult",
  type: "setVariable",
  name: "成年分支",
  params: { target: "workflow:result", value: "成年" },
  inputs: [],
  outputs: [],
};

const setMinorNode: Node = {
  id: "setMinor",
  type: "setVariable",
  name: "未成年分支",
  params: { target: "workflow:result", value: "未成年" },
  inputs: [],
  outputs: [],
};

// end：输入端口 binding workflow:endInput，执行时把值写入 workflow:endResult 槽
const endNode: Node = {
  id: "end",
  type: "end",
  name: "结束",
  params: {},
  inputs: [
    makePort({ id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" }),
  ],
  outputs: [],
};

const edges: readonly Edge[] = [
  { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "setGreeting", targetPortId: "in" },
  { id: "e2", sourceNodeId: "setGreeting", sourcePortId: "out", targetNodeId: "ifElse", targetPortId: "in" },
  { id: "e3", sourceNodeId: "ifElse", sourcePortId: "true", targetNodeId: "setAdult", targetPortId: "in" },
  { id: "e4", sourceNodeId: "ifElse", sourcePortId: "false", targetNodeId: "setMinor", targetPortId: "in" },
  { id: "e5", sourceNodeId: "setAdult", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
  { id: "e6", sourceNodeId: "setMinor", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
];

const workflow: Workflow = {
  id: "hnflow-demo",
  name: "条件分支演示",
  version: "0.1.0",
  nodes: [startNode, setGreetingNode, ifElseNode, setAdultNode, setMinorNode, endNode],
  edges,
  globalVariables: { name: "张三", age: 30 },
};

// ── [2] 序列化：toJSON（精简 JSON，超长截断） ───────────────────────────────

function printTruncated(label: string, json: string, maxLength: number): void {
  const truncated =
    json.length > maxLength
      ? `${json.slice(0, maxLength)}... (截断，共 ${json.length} 字符)`
      : json;
  console.log(`${label}\n${truncated}`);
}

// ── [5] 结果判定：引擎未暴露 context，通过 ifElse 分支端口输出推断 result ────

function judgeResult(result: Awaited<ReturnType<ExecutionEngine["run"]>>): string {
  if (result.status === "failed") {
    return `执行失败：${result.error ?? "未知错误"}`;
  }
  const ifElseOutputs = result.nodeOutputs["ifElse"];
  return ifElseOutputs?.["true"] === true ? "执行成功：result = 成年" : "执行成功：result = 未成年";
}

async function main(): Promise<void> {
  console.log("===== HNFlow v0.1.0 示例演示 =====\n");

  // [1] 创建工作流
  console.log("[1] 创建工作流");
  console.log(`workflow: id=${workflow.id}, name=${workflow.name}, version=${workflow.version}`);
  console.log(`nodes(${workflow.nodes.length}): ${workflow.nodes.map((node) => node.id).join(" -> ")}`);
  console.log(`edges(${workflow.edges.length}): ${workflow.edges.length} 条有向边，ifElse.true/false 分支汇合到 end`);
  console.log(`globalVariables: ${JSON.stringify(workflow.globalVariables)}\n`);

  // [2] 序列化演示
  console.log("[2] 序列化 (toJSON)");
  printTruncated("workflowJSON:", JSON.stringify(toJSON(workflow)), 400);
  const roundTripped = fromJSON(toJSON(workflow));
  console.log(`fromJSON 回读: name=${roundTripped.name}, nodes=${roundTripped.nodes.length}\n`);

  // [3] 保存/加载演示
  console.log("[3] 保存/加载");
  const filePath = join(tmpdir(), "hnflow-demo-workflow.json");
  await saveWorkflow(filePath, workflow);
  console.log(`saved → ${filePath}`);
  const loaded = await loadWorkflow(filePath);
  console.log(`loaded workflow.name = ${loaded.name}\n`);

  // [4] 执行演示
  console.log("[4] 执行 (ExecutionEngine.run)");
  console.log("节点状态流转:");
  const engine = new ExecutionEngine(workflow, {
    events: {
      onNodeStateChange: (info) => {
        console.log(`  ${info.nodeId}: ${info.from} -> ${info.to}`);
      },
    },
  });
  const result = await engine.run();

  // [5] 结果输出
  console.log("\n[5] 执行结果");
  console.log("节点状态矩阵:");
  for (const node of workflow.nodes) {
    console.log(`  ${node.id}: ${result.nodeStates[node.id]}`);
  }
  console.log("节点输出:");
  console.log(JSON.stringify(result.nodeOutputs, null, 2));
  // end 节点已把汇聚值写入 workflow:endResult 槽（context 内）；引擎未暴露 context，
  // 脚本通过 ifElse 的 true/false 端口输出（nodeOutputs）判定走了哪个分支。
  console.log(`\n${judgeResult(result)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`演示失败: ${message}`);
  process.exit(1);
});
