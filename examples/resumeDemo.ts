// HNFlow v0.1.2 示例演示脚本：断点续跑（进程重启后恢复）
// 运行方式：bun run examples/resumeDemo.ts
//
// 演示内容：
//   工作流: start → svA(setVariable x=1) → cmdA(command echo)
//     → humanTask(人工审批) → cmdB(command echo) → end
//   [阶段1] persist run：RunStateStore/HumanTaskStore 落盘 TEMP 目录，挂起返回 waiting
//   [阶段2] 模拟进程重启（丢弃原引擎）→ resumeTask(taskId, ..., "demo-approved") 恢复执行
//   [阶段3] 清理临时文件
//
// 关键 API：ExecutionEngine({ persist, runStateStore, humanTaskStore })、
// resumeTask、RunStateStore、HumanTaskStore。

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import type { ExecutionResult } from "../src/execution/Engine.js";
import { ExecutionEngine } from "../src/execution/Engine.js";
import { resumeTask } from "../src/execution/resume.js";
import { RunStateStore } from "../src/runstate/RunStateStore.js";
import { HumanTaskStore } from "../src/human/HumanTaskStore.js";

// ── 断点/人工任务持久化文件（TEMP 目录） ───────────────────────────────────

const RESUME_DIR = join(tmpdir(), "opencode", "resume-demo");
const RUN_STATES_FILE = join(RESUME_DIR, "run_states.json");
const HUMAN_TASKS_FILE = join(RESUME_DIR, "human_tasks.json");

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

// ── 工作流：start → svA → cmdA → humanTask → cmdB → end ───────────────────

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

// svA：写入 workflow:x=1
const svANode: Node = {
  id: "svA",
  type: "setVariable",
  name: "写入变量 x",
  params: { target: "workflow:x", value: 1 },
  inputs: [],
  outputs: [],
};

// cmdA：node -e 输出固定文本（跨平台安全）
const cmdANode: Node = {
  id: "cmdA",
  type: "command",
  name: "命令执行 A",
  params: {
    command: "node",
    args: ["-e", "console.log('hello from cmdA')"],
  },
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
};

// humanTask：人工审批，首次执行挂起等待人工
const humanTaskNode: Node = {
  id: "humanTask",
  type: "humanTask",
  name: "人工审批",
  params: { title: "人工审批", description: "请审核演示产物" },
  inputs: [],
  outputs: [{ id: "output", name: "output", type: "any", direction: "out" }],
};

// cmdB：人工审批通过后的下游命令
const cmdBNode: Node = {
  id: "cmdB",
  type: "command",
  name: "命令执行 B",
  params: {
    command: "node",
    args: ["-e", "console.log('hello from cmdB')"],
  },
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
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
  { id: "e3", sourceNodeId: "cmdA", sourcePortId: "stdout", targetNodeId: "humanTask", targetPortId: "in" },
  { id: "e4", sourceNodeId: "humanTask", sourcePortId: "output", targetNodeId: "cmdB", targetPortId: "in" },
  { id: "e5", sourceNodeId: "cmdB", sourcePortId: "stdout", targetNodeId: "end", targetPortId: "in" },
];

const workflow: Workflow = {
  id: "hnflow-v012-resume",
  name: "断点续跑演示",
  version: "0.1.2",
  nodes: [startNode, svANode, cmdANode, humanTaskNode, cmdBNode, endNode],
  edges,
};

// ── 结果打印辅助 ──────────────────────────────────────────────────────────

function printResult(label: string, result: ExecutionResult): void {
  console.log(`  [${label}] 执行结果`);
  console.log(`    status: ${result.status}`);
  console.log("    节点状态:");
  for (const node of workflow.nodes) {
    console.log(`      ${node.id}: ${result.nodeStates[node.id]}`);
  }
  console.log(`    cmdB stdout: ${JSON.stringify(result.nodeOutputs["cmdB"]?.["stdout"] ?? "（无）")}`);
}

// ── 清理辅助：删除文件（不存在则忽略） ──────────────────────────────────────

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    console.log(`  已删除: ${filePath}`);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return; // 文件本就不存在，无需清理
    throw error;
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("===== HNFlow v0.1.2 断点续跑演示 =====\n");

  const runStateStore = new RunStateStore({ filePath: RUN_STATES_FILE });
  const humanTaskStore = new HumanTaskStore({ filePath: HUMAN_TASKS_FILE });

  // [阶段1] 首次执行：persist 落盘，humanTask 处挂起返回 waiting
  console.log("[阶段1] 首次执行 run()（persist 落盘）");
  const engine = new ExecutionEngine(workflow, {
    persist: true,
    runStateStore,
    humanTaskStore,
    events: {
      onHumanTaskCreated: (task) => {
        console.log(`  ⏸ 待办已创建: ${task.title} (id=${task.id})`);
      },
      onNodeStateChange: (info) => {
        console.log(`  状态流转: ${info.nodeId}: ${info.from} -> ${info.to}`);
      },
    },
  });
  const first = await engine.run();
  if (first.waitingTask === undefined) {
    throw new Error("首次执行未挂起，断点续跑演示失败");
  }
  console.log(`  执行状态: ${first.status}`);
  console.log(`  挂起任务 title: ${first.waitingTask.title}`);
  console.log(`  挂起节点: ${first.waitingTask.nodeId} (${first.waitingTask.nodeName})`);
  console.log(`  任务 id: ${first.waitingTask.id}`);
  console.log(`  断点文件: ${RUN_STATES_FILE}\n`);

  // [阶段2] 模拟进程重启：丢弃原引擎，用 resumeTask 从断点恢复
  console.log("[阶段2] 模拟进程重启...");
  console.log("  原引擎已丢弃，改用 resumeTask 从断点恢复执行");
  const resumed = await resumeTask(
    first.waitingTask.id,
    { humanTaskStore, runStateStore },
    "demo-approved",
  );
  console.log("  恢复执行完成\n");
  printResult("重启后恢复", resumed);

  // [阶段3] 清理临时文件
  console.log("\n[阶段3] 清理临时文件");
  await cleanupFile(RUN_STATES_FILE);
  await cleanupFile(HUMAN_TASKS_FILE);

  console.log("\n演示结束，正常退出（退出码 0）");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`演示失败: ${message}`);
  process.exitCode = 1;
});
