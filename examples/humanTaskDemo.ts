// HNFlow v0.1.1 示例演示脚本：人工交互闭环
// 运行方式：bun run examples/humanTaskDemo.ts
//
// 演示内容：
//   [主流程] start → setVariable(workflow:name="HNFlow") → command(固定 node 命令)
//            → humanTask(确认发布) → log(流程完成) → end
//     首次 run() 在 humanTask 挂起 → onHumanTaskCreated 打印待办
//     → 模拟人工提交 "approved" → resume(taskId, "approved") 继续执行 → 打印最终结果
//   [skip 流程] start → humanTask → log → end
//     run() 挂起后 skip(taskId) → humanTask 置 Skipped，下游 log/end 自动传播 Skipped
//
// 关键 API：ExecutionEngine.run / resume / skip、HumanTaskStore({ filePath })、
// onHumanTaskCreated 事件（挂起时触发，任务已持久化）。

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import type { ExecutionResult } from "../src/execution/Engine.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";

// ── 常量 ──────────────────────────────────────────────────────────────────

const TASK_FILE = join(tmpdir(), "hnflow-v011-human-tasks.json");

// ── 构造辅助：端口（节点定义里多次出现，提取避免重复样板） ──────────────────

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

// ── [主流程] 人工确认闭环工作流 ────────────────────────────────────────────
// start → setVariable → command → humanTask → log → end

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

// setVariable：写入 workflow:name，演示 workflow 级变量（后续节点可经 ${workflow:name} 读取）
const setNameNode: Node = {
  id: "setName",
  type: "setVariable",
  name: "设置流程名称",
  params: { target: "workflow:name", value: "HNFlow" },
  inputs: [],
  outputs: [],
};

// command：固定 node 命令（不动态插值，保持简单）；输出 stdout/stderr/exitCode
const commandNode: Node = {
  id: "command",
  type: "command",
  name: "执行命令",
  params: {
    command: "node",
    args: ["-e", "console.log('hello from command')"],
  },
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
};

// humanTask：无输入端口；title/description 为静态参数，首次执行挂起等待人工
const humanTaskNode: Node = {
  id: "humanTask",
  type: "humanTask",
  name: "人工确认",
  params: { title: "确认发布", description: "请审核产物" },
  inputs: [],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
};

// log：无输入端口；按 params.level 输出 params.message
const logNode: Node = {
  id: "log",
  type: "log",
  name: "日志输出",
  params: { message: "流程完成" },
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

const mainEdges: readonly Edge[] = [
  { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "setName", targetPortId: "in" },
  { id: "e2", sourceNodeId: "setName", sourcePortId: "out", targetNodeId: "command", targetPortId: "in" },
  { id: "e3", sourceNodeId: "command", sourcePortId: "stdout", targetNodeId: "humanTask", targetPortId: "in" },
  { id: "e4", sourceNodeId: "humanTask", sourcePortId: "output", targetNodeId: "log", targetPortId: "in" },
  { id: "e5", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
];

const mainWorkflow: Workflow = {
  id: "hnflow-v011-human",
  name: "人工确认闭环演示",
  version: "0.1.1",
  nodes: [startNode, setNameNode, commandNode, humanTaskNode, logNode, endNode],
  edges: mainEdges,
};

// ── [skip 流程] 人工任务跳过工作流 ──────────────────────────────────────────
// start → humanTask → log → end；skip 后 humanTask 置 Skipped，下游自动传播 Skipped

const skipStartNode: Node = {
  id: "start",
  type: "start",
  name: "开始",
  params: {},
  inputs: [],
  outputs: [
    makePort({ id: "data", name: "data", type: "any", direction: "out", binding: "workflow:start" }),
  ],
};

const skipHumanTaskNode: Node = {
  id: "humanTask",
  type: "humanTask",
  name: "人工确认",
  params: { title: "确认发布", description: "请审核产物" },
  inputs: [],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
};

const skipLogNode: Node = {
  id: "log",
  type: "log",
  name: "日志输出",
  params: { message: "流程完成" },
  inputs: [],
  outputs: [],
};

const skipEndNode: Node = {
  id: "end",
  type: "end",
  name: "结束",
  params: {},
  inputs: [
    makePort({ id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" }),
  ],
  outputs: [],
};

const skipEdges: readonly Edge[] = [
  { id: "s1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "humanTask", targetPortId: "in" },
  { id: "s2", sourceNodeId: "humanTask", sourcePortId: "output", targetNodeId: "log", targetPortId: "in" },
  { id: "s3", sourceNodeId: "log", sourcePortId: "out", targetNodeId: "end", targetPortId: "in" },
];

const skipWorkflow: Workflow = {
  id: "hnflow-v011-skip",
  name: "人工任务跳过演示",
  version: "0.1.1",
  nodes: [skipStartNode, skipHumanTaskNode, skipLogNode, skipEndNode],
  edges: skipEdges,
};

// ── 结果打印辅助 ──────────────────────────────────────────────────────────

function printResult(label: string, workflow: Workflow, result: ExecutionResult): void {
  console.log(`[${label}] 执行结果`);
  console.log(`  status: ${result.status}`);
  console.log("  节点状态:");
  for (const node of workflow.nodes) {
    console.log(`    ${node.id}: ${result.nodeStates[node.id]}`);
  }
  console.log("  节点输出:");
  console.log(`    ${JSON.stringify(result.nodeOutputs)}`);
}

// ── 主流程：人工确认闭环 ───────────────────────────────────────────────────

async function runHumanClosedLoop(): Promise<void> {
  console.log("===== [主流程] 人工确认闭环 =====\n");

  // [1] 创建 HumanTaskStore（JSON 文件持久化）并注入引擎，注册人工任务事件
  const store = new HumanTaskStore({ filePath: TASK_FILE });
  const engine = new ExecutionEngine(mainWorkflow, {
    humanTaskStore: store,
    events: {
      onHumanTaskCreated: (task) => {
        console.log(`⏸ 待办已创建: ${task.title} (id=${task.id})`);
      },
      onNodeStateChange: (info) => {
        console.log(`  状态流转: ${info.nodeId}: ${info.from} -> ${info.to}`);
      },
    },
  });

  // [2] 首次执行：start → setVariable → command 依次 Success，humanTask 挂起
  console.log("[1] 首次执行 run()");
  const first = await engine.run();
  if (first.waitingTask === undefined) {
    throw new Error("首次执行未挂起，humanTask 演示失败");
  }
  console.log("工作流挂起，等待人工…");
  const task = first.waitingTask;
  console.log(`  等待任务 id: ${task.id}`);
  console.log(`  挂起节点: ${task.nodeId} (${task.nodeName})`);
  console.log(`  title: ${task.title}`);
  console.log(`  description: ${task.description ?? "（无）"}`);
  console.log(`  status: ${task.status}`);
  console.log(`  command stdout: ${JSON.stringify(first.nodeOutputs["command"]?.["stdout"] ?? "（无）")}\n`);

  // [3] 模拟人工提交：resume 写入产物并继续执行剩余节点
  console.log("[2] 人工提交并恢复 resume()");
  console.log("✅ 用户提交产物: approved");
  const resumed = await engine.resume(task.id, "approved");

  // [4] 打印最终结果
  printResult("主流程", mainWorkflow, resumed);
  console.log(`  humanTask 输出: ${JSON.stringify(resumed.nodeOutputs["humanTask"])}`);
  console.log(`  log 节点日志: ${JSON.stringify(engine.logs)}\n`);
}

// ── skip 流程：人工任务跳过与下游传播 ──────────────────────────────────────

async function runSkipFlow(): Promise<void> {
  console.log("===== [skip 流程] 人工任务跳过 =====\n");

  const store = new HumanTaskStore({ filePath: TASK_FILE });
  const engine = new ExecutionEngine(skipWorkflow, { humanTaskStore: store });

  // [1] 首次执行：humanTask 挂起
  console.log("[1] 首次执行 run()");
  const first = await engine.run();
  if (first.waitingTask === undefined) {
    throw new Error("skip 流程首次执行未挂起，演示失败");
  }
  console.log(`工作流挂起，等待人工… (任务 id=${first.waitingTask.id})`);

  // [2] 跳过人工任务：humanTask 置 Skipped，下游 log/end 自动传播 Skipped
  console.log("[2] 跳过人工任务 skip()");
  const skipped = await engine.skip(first.waitingTask.id);

  printResult("skip 流程", skipWorkflow, skipped);
}

// ── 清理：删除临时 store 文件（不存在则忽略） ──────────────────────────────

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function cleanupStoreFile(): Promise<void> {
  try {
    await unlink(TASK_FILE);
    console.log(`已清理临时 store 文件: ${TASK_FILE}`);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return; // 文件本就不存在，无需清理
    throw error;
  }
}

async function main(): Promise<void> {
  await runHumanClosedLoop();
  await runSkipFlow();
  await cleanupStoreFile();
  console.log("\n演示结束，正常退出（退出码 0）");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`演示失败: ${message}`);
  process.exitCode = 1;
});
