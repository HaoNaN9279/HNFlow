// v0.4.2 内存单次运行纯逻辑单测（无 electron，bun test 直跑）。
// v0.4.3 验收 3：runWorkflowOnce 内置 MCP 池 + groupsRootDir → AI 节点（功能组 mcp.json）/ mcpTool 节点桌面端可消费 MCP 工具。
// 运行方式：仓库根 `bun test apps/desktop/src/ipc/__tests__/run.test.ts`（echo-server 夹具路径相对 cwd 定位）。
import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerPool } from "../../../../../src/mcp/pool.js";
import { runWorkflowOnce } from "../run.js";
import type { RunWorkflowPayload } from "../../shared/ipc.js";
import type { Workflow } from "../../../../../src/model/types.js";

/** 便捷构造合法 workflow 节点（port 形状与 workflowSchema 对齐）。 */
function node(
  id: string,
  type: string,
  name: string,
  params: Readonly<Record<string, unknown>>,
  ports: { readonly inputs: Workflow["nodes"][number]["inputs"]; readonly outputs: Workflow["nodes"][number]["outputs"] },
) {
  return { id, type, name, params, ...ports };
}

const startNode = node("start", "start", "开始", {}, {
  inputs: [],
  outputs: [{ id: "data", name: "data", type: "any", direction: "out" }],
});

const endNode = node("end", "end", "结束", {}, {
  inputs: [{ id: "in", name: "in", type: "any", direction: "in" }],
  outputs: [],
});

const logNode = node("log", "log", "日志", { message: "hello", level: "info" }, { inputs: [], outputs: [] });

const commandNode = node("cmd", "command", "执行命令", {}, {
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
});

/** 待审核 command 节点：reviewRequired=true，命令为安全 node 脚本（v0.4.2 验收 2 审核流）。 */
const reviewCommandNode = node("cmd-review", "command", "待审核命令", {
  command: "node",
  args: ["-e", "console.log('review-ok')"],
  reviewRequired: true,
}, {
  inputs: [],
  outputs: [
    { id: "stdout", name: "stdout", type: "string", direction: "out" },
    { id: "stderr", name: "stderr", type: "string", direction: "out" },
    { id: "exitCode", name: "exitCode", type: "number", direction: "out" },
  ],
});

describe("runWorkflowOnce", () => {
  it("简单 workflow（start→log→end）运行成功 ok:true 且带 runId", async () => {
    const result = await runWorkflowOnce({
      workflow: { id: "run-ok-wf", name: "运行成功", version: "0.1.0", nodes: [startNode, logNode, endNode], edges: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId.length).toBeGreaterThan(0);
    }
  });

  it("失败 workflow（command 参数非法）→ ok:false 带中文消息与 nodeId/nodePath", async () => {
    const result = await runWorkflowOnce({
      workflow: { id: "run-fail-wf", name: "运行失败", version: "0.1.0", nodes: [startNode, commandNode], edges: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("执行命令");
      expect(result.message).toContain("invalid command params");
      expect(result.nodeId).toBe("cmd");
      expect(result.nodePath).toContain("顶层工作流");
    }
  });

  it("非法 workflow（节点缺 name）→ 中文校验错误消息", async () => {
    const result = await runWorkflowOnce({
      workflow: {
        id: "run-invalid-wf",
        name: "非法",
        version: "0.1.0",
        nodes: [{ id: "start", type: "start", params: {}, inputs: [], outputs: [] }], // 缺 name
        edges: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/^工作流数据不合法/);
    }
  });
});

describe("runWorkflowOnce 调试信息（T2b）", () => {
  it("成功路径：debug 携带节点状态/日志/上下文快照/时间（含全部节点）", async () => {
    const result = await runWorkflowOnce({
      workflow: { id: "run-debug-ok-wf", name: "调试成功", version: "0.1.0", nodes: [startNode, logNode, endNode], edges: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.debug).toBeDefined();
      if (result.debug === undefined) return; // 窄化：本路径 debug 必存在
      expect(result.debug.runId).toBe(result.runId);
      // nodeStates 覆盖全部节点且终态 Success
      expect(result.debug.nodeStates).toEqual({ start: "Success", log: "Success", end: "Success" });
      // logs 非空：log 节点经 logger.info 写入
      expect(result.debug.logs.length).toBeGreaterThan(0);
      // contextSnapshot 三层形状正确（global/workflow 为空对象，node 无节点级上下文写入）
      expect(result.debug.contextSnapshot.global).toEqual({});
      expect(result.debug.contextSnapshot.workflow).toEqual({});
      expect(result.debug.contextSnapshot.node).toEqual({});
      // 时间单调
      expect(result.debug.startTime).toBeLessThanOrEqual(result.debug.endTime);
    }
  });

  it("失败路径：debug 仍存在，nodeStates 含 Failed 节点、logs 非空（查错依据）", async () => {
    const result = await runWorkflowOnce({
      workflow: { id: "run-debug-fail-wf", name: "调试失败", version: "0.1.0", nodes: [startNode, commandNode], edges: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.debug).toBeDefined();
      if (result.debug === undefined) return; // 窄化：失败路径也组装 debug
      // 失败节点标记 Failed，其余成功
      expect(result.debug.nodeStates).toEqual({ start: "Success", cmd: "Failed" });
      // 失败日志非空：错误消息/节点路径存于日志 data（extractNodePath 依赖）
      expect(result.debug.logs.length).toBeGreaterThan(0);
      expect(result.debug.contextSnapshot.global).toEqual({});
      expect(result.debug.contextSnapshot.workflow).toEqual({});
      expect(result.debug.startTime).toBeLessThanOrEqual(result.debug.endTime);
    }
  });
});

describe("runWorkflowOnce 审核桥接（v0.4.2 验收 2）", () => {
  const reviewWorkflow: RunWorkflowPayload = {
    workflow: {
      id: "run-review-wf",
      name: "审核流",
      version: "0.1.0",
      nodes: [reviewCommandNode],
      edges: [],
    },
  };

  it("onReviewRequest 返回 approve → 命令执行成功 ok:true", async () => {
    const result = await runWorkflowOnce(reviewWorkflow, {
      onReviewRequest: async (request) => {
        expect(request.nodeId).toBe("cmd-review");
        expect(request.description).toContain("node");
        expect(request.requestId.length).toBeGreaterThan(0);
        return "approve";
      },
    });
    expect(result.ok).toBe(true);
  });

  it("onReviewRequest 返回 reject → ok:false 带审核中文消息", async () => {
    const result = await runWorkflowOnce(reviewWorkflow, {
      onReviewRequest: async () => "reject",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("命令待人工审核");
      expect(result.nodeId).toBe("cmd-review");
    }
  });

  it("不传 onReviewRequest → 缺省拒绝 → ok:false", async () => {
    const result = await runWorkflowOnce(reviewWorkflow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("命令待人工审核");
    }
  });
});

// ---- v0.4.3 验收 3：MCP 池接入 ----
// 夹具目录（系统临时目录，测试后清理）；echo-server 夹具路径相对仓库根（测试在根目录运行）。
const RUN_TEMP_BASE = join(tmpdir(), "hnflow-run-mcp-test");
const ECHO_SERVER_PATH = join(process.cwd(), "tests", "fixtures", "mcp", "echo-server.ts");

/** 写功能组定义 + v1.0.0/mcp.json（name=echo-server，其余字段透传；参照 tests/ai-node-mcp.test.ts 写盘模式）。 */
async function writeMcpGroup(
  base: string,
  guid: string,
  namespace: string,
  mcpConfig: Record<string, unknown>,
): Promise<void> {
  const groupDir = join(base, ...namespace.split("/"));
  await mkdir(groupDir, { recursive: true });
  await writeFile(
    join(groupDir, "group.json"),
    JSON.stringify({
      guid,
      namespace,
      aliases: [],
      description: "MCP 功能组",
      currentVersion: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          createdAt: "2026-08-01T00:00:00.000Z",
          changelog: "初版",
          content: { tools: [], mcps: ["mcp.json"], rules: [] },
        },
      ],
    }),
    "utf8",
  );
  const versionDir = join(groupDir, "v1.0.0");
  await mkdir(versionDir, { recursive: true });
  await writeFile(
    join(versionDir, "mcp.json"),
    JSON.stringify({ name: "echo-server", ...mcpConfig }),
    "utf8",
  );
}

describe("runWorkflowOnce MCP 池（v0.4.3 验收 3）", () => {
  // dispose spy：保留原实现（真正关闭子进程），仅记录调用；每用例后断言成功/失败路径都释放。
  const originalDispose = McpServerPool.prototype.dispose;
  let disposeSpy: Mock<McpServerPool["dispose"]>;

  beforeEach(async () => {
    disposeSpy = spyOn(McpServerPool.prototype, "dispose").mockImplementation(originalDispose);
    await rm(RUN_TEMP_BASE, { recursive: true, force: true });
    await mkdir(RUN_TEMP_BASE, { recursive: true });
  });

  afterEach(() => {
    // 无残留进程：无论用例成败，池 dispose 必须被调用（释放 MCP 子进程）。
    expect(disposeSpy).toHaveBeenCalled();
    disposeSpy.mockRestore();
  });

  it("AI 节点 + 功能组 mcp.json 端到端：MCP 工具调用成功 → ok:true", async () => {
    await writeMcpGroup(RUN_TEMP_BASE, "g-echo", "echo/demo", {
      command: "bun",
      args: ["run", ECHO_SERVER_PATH],
    });
    const result = await runWorkflowOnce(
      {
        workflow: {
          id: "run-mcp-ai-wf",
          name: "MCP AI 工作流",
          version: "0.1.0",
          nodes: [
            startNode,
            node(
              "ai",
              "ai",
              "AI 节点",
              {
                model: {
                  provider: "fake",
                  model: "test",
                  fakeScript: [
                    { kind: "tool_call", toolCall: { name: "echo-server.echo", args: { text: "你好" } } },
                    { kind: "text", text: "完成" },
                  ],
                },
                inputMessages: "测试 MCP 工具",
                capabilityGroups: [{ guid: "g-echo", version: "1.0.0" }],
              },
              { inputs: [], outputs: [{ id: "output", name: "output", type: "any", direction: "out" }] },
            ),
            endNode,
          ],
          edges: [{ id: "e1", sourceNodeId: "ai", sourcePortId: "output", targetNodeId: "end", targetPortId: "in" }],
        },
      },
      { groupsRootDir: RUN_TEMP_BASE },
    );
    // fakeScript tool_call 需真实调 MCP 工具：若功能组/pool 未接入，工具不存在 → 节点失败 → ok:false。
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId.length).toBeGreaterThan(0);
    }
  }, 20000);

  it("mcpTool 节点端到端：无功能组也成功（只依赖池）→ ok:true", async () => {
    const result = await runWorkflowOnce({
      workflow: {
        id: "run-mcp-tool-wf",
        name: "MCP 工具节点工作流",
        version: "0.1.0",
        nodes: [
          node(
            "mt",
            "mcpTool",
            "MCP 工具",
            {
              serverName: "echo-server",
              toolName: "echo",
              mcpConfig: { command: "bun", args: ["run", ECHO_SERVER_PATH] },
              args: { text: "你好" },
            },
            { inputs: [], outputs: [{ id: "result", name: "result", type: "string", direction: "out" }] },
          ),
        ],
        edges: [],
      },
    });
    // mcpTool 只依赖池：池已注入 → echo 调用成功；未注入则 McpPoolUnavailableError → ok:false。
    expect(result.ok).toBe(true);
  }, 20000);

  it("失败路径也释放：mcpTool 指向坏命令 → ok:false 且 dispose 被调用（afterEach 断言）", async () => {
    const result = await runWorkflowOnce({
      workflow: {
        id: "run-mcp-tool-fail-wf",
        name: "MCP 失败工作流",
        version: "0.1.0",
        nodes: [
          node(
            "mt",
            "mcpTool",
            "MCP 工具",
            { serverName: "echo-server", toolName: "echo", mcpConfig: { command: "nonexistent-cmd-xyz" } },
            { inputs: [], outputs: [{ id: "result", name: "result", type: "string", direction: "out" }] },
          ),
        ],
        edges: [],
      },
    });
    expect(result.ok).toBe(false);
  }, 20000);

  it("池 dispose 后 MCP 子进程退出（无残留）", async () => {
    const pool = new McpServerPool();
    const session = await pool.acquire({ name: "echo-server", command: "bun", args: ["run", ECHO_SERVER_PATH] });
    const pid = session.getPid();
    if (pid === null) {
      await pool.dispose();
      throw new Error("MCP 会话未启动子进程");
    }
    await pool.dispose();
    // process.kill(pid, 0) 不抛错 = 进程仍存在；抛错（ESRCH） = 已退出。
    let exited = false;
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
    }
    expect(exited).toBe(true);
  }, 20000);
});
