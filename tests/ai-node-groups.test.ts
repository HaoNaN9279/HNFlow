// AI 节点功能组消费测试（v0.3.1 T6）：activeGroups 工具追加 / 未注册跳过 /
// systemPrompt 拼接 / 冲突 warn / 无 activeGroups 行为不变 / 仅 agent 文本。
// 夹具惯例同 ai-node.test.ts：fake-llm 脚本驱动执行 + aiExecutor.execute 包装捕获 request。
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { aiExecutor } from "../src/ai/executor-instance.js";
import type { AIExecutionRequest } from "../src/ai/executor.js";
import { clearTools, registerTool } from "../src/ai/toolRegistry.js";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { MergedGroups, MergedTool } from "../src/groups/merge.js";
import type { Node } from "../src/model/types.js";
import { aiNode } from "../src/nodes/ai.js";
import { registry } from "../src/nodes/registry.js";

/** 日志收集：断言冲突 warn 用。 */
interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly data: unknown;
}

function makeNode(
  id: string,
  type: string,
  params: Readonly<Record<string, unknown>> = {},
): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function createMockContext(
  node: Node,
  logs: LogEntry[] = [],
  activeGroups?: MergedGroups,
): NodeExecutionContext {
  const store: Record<string, unknown> = {};
  return {
    node,
    workflowId: "test-wf",
    ...(activeGroups !== undefined ? { activeGroups } : {}),
    get(scope, key) {
      return store[`${scope}:${key}`];
    },
    set(scope, key, value) {
      store[`${scope}:${key}`] = value;
    },
    getByPath(path) {
      return store[path];
    },
    setByPath(path, value) {
      store[path] = value;
    },
    getAll(scope) {
      const result: Record<string, unknown> = {};
      const prefix = `${scope}:`;
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          result[key.slice(prefix.length)] = store[key];
        }
      }
      return result;
    },
    suspend() {
      throw new Error("suspend not implemented in test mock");
    },
    logger: {
      info: (msg, data) => logs.push({ level: "info", msg, data }),
      warn: (msg, data) => logs.push({ level: "warn", msg, data }),
      error: (msg, data) => logs.push({ level: "error", msg, data }),
    },
  };
}

/** 包装共享执行器仅记录 request 并透传真实执行（断言 request 组装用）。 */
async function captureRequest(run: () => unknown): Promise<AIExecutionRequest> {
  const original = aiExecutor.execute;
  let captured: AIExecutionRequest | undefined;
  aiExecutor.execute = async (req) => {
    captured = req;
    return original.call(aiExecutor, req);
  };
  try {
    await run();
  } finally {
    aiExecutor.execute = original;
  }
  if (captured === undefined) {
    throw new Error("aiExecutor.execute 未被调用");
  }
  return captured;
}

/** 功能组合并工具夹具：fullName 含命名空间前缀，namespace/baseName 与 T2 merge 语义一致。 */
function mergedTool(fullName: string): MergedTool {
  return {
    fullName,
    namespace: "web/scraping/playwright",
    baseName: "read_file",
    description: "读取文件内容",
    parameters: {},
    sourceGuid: "g1",
    sourceVersion: "0.1.0",
  };
}

/** MergedGroups 夹具：只保留传入字段（exactOptionalPropertyTypes：不存在的可选字段不写出）。 */
function mergedGroups(overrides: Partial<Omit<MergedGroups, "supplementaryAgents">>): MergedGroups {
  return {
    supplementaryAgents: [],
    tools: [],
    rules: [],
    mcps: [],
    conflicts: [],
    ...overrides,
  };
}

/** 代码注册的组工具：handler 记录被调用并返回固定文本。 */
function readFileTool(): { tool: ReturnType<typeof makeReadFileTool>; isCalled: () => boolean } {
  let called = false;
  return {
    tool: makeReadFileTool(() => {
      called = true;
    }),
    isCalled: () => called,
  };
}

function makeReadFileTool(onCalled: () => void) {
  return {
    name: "web/scraping/playwright.read_file",
    description: "读取文件内容",
    parameters: z.object({ path: z.string() }),
    handler: (input: Record<string, unknown>) => {
      onCalled();
      return `内容: ${String(input["path"])}`;
    },
  };
}

const textScript: FakeScriptStep[] = [{ kind: "text", text: "ok" }];

afterEach(() => {
  clearTools();
});

describe("ai 节点功能组消费（T6）", () => {
  test("工具追加：activeGroups 已注册工具进 request.tools 且模型可调用 handler", async () => {
    const { tool, isCalled } = readFileTool();
    registerTool(tool);
    const node = makeNode("ai", "ai", {
      model: {
        provider: "fake",
        model: "test",
        fakeScript: [
          { kind: "tool_call", toolCall: { name: "web/scraping/playwright.read_file", args: { path: "a.txt" } } },
          { kind: "text", text: "完成" },
        ],
      },
      inputMessages: "读文件",
    });
    const ctx = createMockContext(node, [], mergedGroups({
      tools: [mergedTool("web/scraping/playwright.read_file")],
    }));
    const request = await captureRequest(() => aiNode.execute(ctx));
    expect(request.tools.map((t) => t.name)).toEqual(["web/scraping/playwright.read_file"]);
    expect(isCalled()).toBe(true);
  });

  test("工具追加：baseTools 在前、groupTools 在后（params.tools 与 activeGroups 混合）", async () => {
    registerTool(readFileTool().tool);
    registerTool({
      name: "demo.getWeather",
      description: "查询天气",
      parameters: z.object({ city: z.string() }),
      handler: () => "晴",
    });
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
      tools: ["demo.getWeather"],
    });
    const ctx = createMockContext(node, [], mergedGroups({
      tools: [mergedTool("web/scraping/playwright.read_file")],
    }));
    const request = await captureRequest(() => aiNode.execute(ctx));
    expect(request.tools.map((t) => t.name)).toEqual([
      "demo.getWeather",
      "web/scraping/playwright.read_file",
    ]);
  });

  test("未注册工具跳过：不抛错、不进 request.tools（模型不可见）", async () => {
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
    });
    const ctx = createMockContext(node, [], mergedGroups({
      tools: [mergedTool("web/scraping/nonexistent.read")],
    }));
    const request = await captureRequest(() => aiNode.execute(ctx));
    expect(request.tools).toEqual([]);
  });

  test("systemPrompt 拼接：节点 prompt 在前、agent 文本在后，\\n\\n 分隔", async () => {
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      systemPrompt: "你是助手",
      inputMessages: "你好",
    });
    const ctx = createMockContext(node, [], mergedGroups({
      agent: { text: "你是功能组 agent", sourceGuid: "g1", sourceNamespace: "demo" },
    }));
    const request = await captureRequest(() => aiNode.execute(ctx));
    expect(request.systemPrompt).toBe("你是助手\n\n【功能组 Agent 身份】\n你是功能组 agent");
  });

  test("agent 存在但节点无 systemPrompt：仅 agent 文本", async () => {
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
    });
    const ctx = createMockContext(node, [], mergedGroups({
      agent: { text: "你是功能组 agent", sourceGuid: "g1", sourceNamespace: "demo" },
    }));
    const request = await captureRequest(() => aiNode.execute(ctx));
    expect(request.systemPrompt).toBe("【功能组 Agent 身份】\n你是功能组 agent");
  });

  test("无 activeGroups：行为不变（systemPrompt 原样、tools 仅 base）", async () => {
    registerTool(readFileTool().tool);
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      systemPrompt: "你是助手",
      tools: ["web/scraping/playwright.read_file"],
      inputMessages: "你好",
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node)));
    expect(request.systemPrompt).toBe("你是助手");
    expect(request.tools.map((t) => t.name)).toEqual(["web/scraping/playwright.read_file"]);
  });

  test("无 activeGroups 且节点无 systemPrompt：request 不含 systemPrompt 字段", async () => {
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node)));
    expect(request.systemPrompt).toBeUndefined();
  });

  test("冲突 warn：logger.warn 输出互斥信息（kind=group_rule_conflict）", async () => {
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
    });
    const ctx = createMockContext(node, logs, mergedGroups({
      conflicts: [
        {
          rulePathA: "g1/rules/a.md",
          rulePathB: "g2/rules/b.md",
          constraintA: "never",
          constraintB: "always",
        },
      ],
    }));
    await aiNode.execute(ctx);
    const warns = logs.filter((entry) => entry.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe(
      "功能组规则互斥：g1/rules/a.md（constraint: never）与 g2/rules/b.md（constraint: always）",
    );
    expect(warns[0]?.data).toEqual({
      kind: "group_rule_conflict",
      rulePathA: "g1/rules/a.md",
      rulePathB: "g2/rules/b.md",
      constraintA: "never",
      constraintB: "always",
    });
  });

  test("无冲突：不产生 warn 日志", async () => {
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
    });
    const ctx = createMockContext(node, logs, mergedGroups({
      tools: [mergedTool("web/scraping/playwright.read_file")],
    }));
    await aiNode.execute(ctx);
    expect(logs.filter((entry) => entry.level === "warn")).toHaveLength(0);
  });
});
