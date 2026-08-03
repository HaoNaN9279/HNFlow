// HNFlow v0.1.2 示例演示脚本：子工作流打包与执行
// 运行方式：bun run examples/subworkflowDemo.ts
//
// 演示内容：
//   父工作流（6 节点）: start → svA(setVariable 写 x=10) → cmdA(command echo)
//     → svB(setVariable 读 x+5) → log → end
//   [1] 构造父工作流
//   [2] packageSubgraph 打包中间节点 svA/cmdA/svB 为单个 subworkflow 节点
//       打印子节点 id / 输入输出端口 / 子图节点数 / dependencies 依赖快照
//   [3] ExecutionEngine 执行打包后父图 → 打印各节点状态与子节点 out 输出
//   [4] expandSubgraph 展开还原 → 打印还原后节点数（验证往返）
//
// 关键 API：packageSubgraph / expandSubgraph、ExecutionEngine.run、subworkflow 节点。

import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import type { ExecutionResult } from "../src/execution/Engine.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { expandSubgraph, packageSubgraph } from "../src/subgraph/index.js";

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
    : {
        id: spec.id,
        name: spec.name,
        type: spec.type,
        direction: spec.direction,
        binding: spec.binding,
      };
}

// ── [1] 父工作流：start → svA → cmdA → svB → log → end ─────────────────────

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

// svA：写入 workflow:x=10；显式 out 端口供子图内部边校验
const svANode: Node = {
  id: "svA",
  type: "setVariable",
  name: "写入变量 x",
  params: { target: "workflow:x", value: 10 },
  inputs: [],
  outputs: [makePort({ id: "out", name: "out", type: "any", direction: "out" })],
};

// cmdA：node -e 输出固定文本（跨平台安全）；显式 in 端口供子图内部边校验
const cmdANode: Node = {
  id: "cmdA",
  type: "command",
  name: "命令执行 A",
  params: {
    command: "node",
    args: ["-e", "console.log('hello from cmdA')"],
  },
  inputs: [makePort({ id: "in", name: "in", type: "any", direction: "in" })],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
};

// svB：读取 workflow:x 并拼接 +5 写入 workflow:y；显式 in/out 端口供子图内部边校验
const svBNode: Node = {
  id: "svB",
  type: "setVariable",
  name: "读取 x 并拼接 +5",
  params: { target: "workflow:y", value: "${workflow:x}+5" },
  inputs: [makePort({ id: "in", name: "in", type: "any", direction: "in" })],
  outputs: [makePort({ id: "out", name: "out", type: "any", direction: "out" })],
};

const logNode: Node = {
  id: "log",
  type: "log",
  name: "日志输出",
  params: { message: "父流程执行完成" },
  inputs: [],
  outputs: [],
};

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
  { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "svA", targetPortId: "in" },
  { id: "e2", sourceNodeId: "svA", sourcePortId: "out", targetNodeId: "cmdA", targetPortId: "in" },
  { id: "e3", sourceNodeId: "cmdA", sourcePortId: "stdout", targetNodeId: "svB", targetPortId: "in" },
  { id: "e4", sourceNodeId: "svB", sourcePortId: "out", targetNodeId: "log", targetPortId: "in" },
  { id: "e5", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
];

const workflow: Workflow = {
  id: "hnflow-v012-subworkflow",
  name: "子工作流打包演示",
  version: "0.1.2",
  nodes: [startNode, svANode, cmdANode, svBNode, logNode, endNode],
  edges,
};

// 打包选中集：中间 3 节点折叠为子工作流
const PACK_NODE_IDS = ["svA", "cmdA", "svB"];

// ── 结果打印辅助 ──────────────────────────────────────────────────────────

function describePort(port: Port): string {
  const binding = port.binding === undefined ? "" : `, binding=${port.binding}`;
  return `${port.id}(${port.type}, ${port.direction}${binding})`;
}

function printResult(workflow: Workflow, result: ExecutionResult): void {
  console.log("  节点状态:");
  for (const node of workflow.nodes) {
    console.log(`    ${node.id}: ${result.nodeStates[node.id]}`);
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("===== HNFlow v0.1.2 子工作流打包与执行演示 =====\n");

  // [1] 构造父工作流
  console.log("[1] 构造父工作流");
  console.log(`  节点(${workflow.nodes.length}): ${workflow.nodes.map((node) => node.id).join(" -> ")}`);
  console.log(`  边(${edges.length}): start → svA → cmdA → svB → log → end\n`);

  // [2] 打包子工作流
  console.log("[2] 打包子工作流 (packageSubgraph)");
  console.log(`  选中节点: ${PACK_NODE_IDS.join(" -> ")}`);
  const packed = packageSubgraph(workflow, PACK_NODE_IDS);
  const subNode = packed.workflow.nodes.find((node) => node.id === packed.subNodeId);
  if (subNode === undefined) {
    throw new Error("打包结果缺少 subworkflow 节点");
  }
  console.log(`  子工作流节点 id: ${packed.subNodeId}`);
  console.log(`  输入端口: ${subNode.inputs.map(describePort).join("; ")}`);
  console.log(`  输出端口: ${subNode.outputs.map(describePort).join("; ")}`);
  console.log(`  子图节点数: ${packed.subWorkflow.nodes.length}（含自动补的 __end）`);
  console.log(`  子图节点: ${packed.subWorkflow.nodes.map((node) => node.id).join(" -> ")}`);
  console.log(`  dependencies 依赖快照: ${JSON.stringify(subNode.params["dependencies"])}`);
  console.log(`  打包后父图节点: ${packed.workflow.nodes.map((node) => node.id).join(" -> ")}\n`);

  // [3] 执行打包后工作流
  console.log("[3] 执行打包后工作流 (ExecutionEngine.run)");
  const engine = new ExecutionEngine(packed.workflow);
  const result = await engine.run();
  console.log(`  执行状态: ${result.status}`);
  printResult(packed.workflow, result);
  const subOutputs = result.nodeOutputs[packed.subNodeId];
  console.log(`  子工作流节点输出: ${JSON.stringify(subOutputs)}`);
  // 子图无显式收口数据（自动补的 __end 无数据流入），out 输出为 undefined
  console.log(`    out 值: ${String(subOutputs?.["out"])}\n`);

  // [4] 展开还原（验证打包往返）
  console.log("[4] 展开还原 (expandSubgraph)");
  const expanded = expandSubgraph(packed.workflow, packed.subNodeId);
  console.log(`  还原后节点数: ${expanded.nodes.length}（原始父图 ${workflow.nodes.length}）`);
  console.log(`  还原后节点: ${expanded.nodes.map((node) => node.id).join(" -> ")}`);
  console.log(`  还原后边数: ${expanded.edges.length}（原始 ${workflow.edges.length}）`);

  console.log("\n演示结束，正常退出（退出码 0）");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`演示失败: ${message}`);
  process.exitCode = 1;
});
