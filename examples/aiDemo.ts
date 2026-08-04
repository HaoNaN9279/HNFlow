// HNFlow v0.2.0 AI 节点示例：调用真实 OpenAI 模型 + 工具调用。
// 运行方式（PowerShell，Windows）：
//   $env:OPENAI_API_KEY="sk-..." ; bun run examples/aiDemo.ts
// 或先设置环境变量再运行：setx OPENAI_API_KEY "sk-..." 后 bun run examples/aiDemo.ts
//
// 流程：start → ai（provider openai + demo.getCurrentTime 工具）→ end。
// 未配置 OPENAI_API_KEY 时打印提示并退出（不抛错）。

import { z } from "zod";
import type { Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import { registerTool } from "../src/ai/toolRegistry.js";
import { ExecutionEngine } from "../src/execution/Engine.js";

// ── 端口构造辅助：binding 可选，避免重复样板 ─────────────────────────────────

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

// ── 注册演示工具：返回当前时间字符串 ─────────────────────────────────────────

registerTool({
  name: "demo.getCurrentTime",
  description: "获取当前日期与时间，返回中文格式字符串",
  parameters: z.object({}),
  handler: () => new Date().toLocaleString("zh-CN"),
});

// ── 创建工作流：start → ai → end ────────────────────────────────────────────

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

const aiNode: Node = {
  id: "ai",
  type: "ai",
  name: "AI 助手",
  params: {
    model: { provider: "openai", model: "gpt-4o-mini" },
    systemPrompt: "你是 HNFlow 演示助手，回答问题要简洁。",
    inputMessages: "现在几点？",
    tools: ["demo.getCurrentTime"],
  },
  inputs: [],
  outputs: [makePort({ id: "output", name: "output", type: "any", direction: "out" })],
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

const workflow: Workflow = {
  id: "hnflow-ai-demo",
  name: "AI 节点演示",
  version: "0.2.0",
  nodes: [startNode, aiNode, endNode],
  edges: [
    { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "ai", targetPortId: "in" },
    { id: "e2", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" },
  ],
};

async function main(): Promise<void> {
  if (process.env["OPENAI_API_KEY"] === undefined || process.env["OPENAI_API_KEY"] === "") {
    console.log("未检测到 OPENAI_API_KEY，跳过真实模型调用。");
    console.log('运行方式（PowerShell）：$env:OPENAI_API_KEY="sk-..." ; bun run examples/aiDemo.ts');
    return;
  }

  console.log("===== HNFlow v0.2.0 AI 节点示例 =====");
  console.log(`workflow: ${workflow.id}，模型 gpt-4o-mini，工具 demo.getCurrentTime\n`);

  const engine = new ExecutionEngine(workflow, {
    events: {
      onNodeStateChange: (info) => {
        console.log(`  ${info.nodeId}: ${info.from} -> ${info.to}`);
      },
    },
  });
  const result = await engine.run();

  if (result.status === "failed") {
    console.error(`执行失败：${result.error ?? "未知错误"}`);
    process.exit(1);
  }

  const aiOutput = result.nodeOutputs["ai"];
  console.log("\n节点状态矩阵:");
  for (const node of workflow.nodes) {
    console.log(`  ${node.id}: ${result.nodeStates[node.id]}`);
  }
  console.log("\nAI 节点结果:");
  console.log(`  output: ${aiOutput?.["output"]}`);
  console.log(`  toolCalls: ${JSON.stringify(aiOutput?.["toolCalls"])}`);
  console.log(`  endResult: ${engine.getWorkflowVariable("endResult")}`);
  console.log("\n消息轨迹:");
  console.log(JSON.stringify(aiOutput?.["messages"], null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`演示失败: ${message}`);
  process.exit(1);
});
