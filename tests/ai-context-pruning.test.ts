// AI 节点工具上下文动态裁剪测试（v0.9.6）：
// ai-groups 纯函数（filterToolsByMode/relevanceScore/selectRelevantTools/
// estimateToolsTokens/enforceToolBudget）+ ai 节点集成（subset 白名单注入、
// auto 相关度排序、toolBudget 超限 warn）+ param-fields schema 3 字段。
// 夹具惯例同 ai-node.test.ts / ai-node-groups.test.ts：fake-llm 脚本驱动执行
// + aiExecutor.execute 包装捕获 request。
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { aiExecutor } from "../src/ai/executor-instance.js";
import type { AIExecutionRequest } from "../src/ai/executor.js";
import type { FakeScriptStep } from "../src/ai/fake-llm.js";
import { clearTools, registerTool } from "../src/ai/toolRegistry.js";
import type { HNFlowTool } from "../src/ai/types.js";
import type { NodeExecutionContext } from "../src/execution/types.js";
import type { Node } from "../src/model/types.js";
import { aiNode, InvalidAIParamsError } from "../src/nodes/ai.js";
import {
  enforceToolBudget,
  estimateToolsTokens,
  filterToolsByMode,
  relevanceScore,
  selectRelevantTools,
} from "../src/nodes/ai-groups.js";
import { aiParamsSchema } from "../src/nodes/param-fields.js";
import { registry } from "../src/nodes/registry.js";

/** 构造 HNFlowTool 夹具：name/description 可控，handler 固定返回。 */
function makeTool(name: string, description: string): HNFlowTool {
  return {
    name,
    description,
    parameters: z.object({}),
    handler: () => "ok",
  };
}

/** 天气工具：ReAct 集成测试用（handler 返回固定文本）。 */
function weatherTool(): HNFlowTool {
  return {
    name: "demo.getWeather",
    description: "查询天气",
    parameters: z.object({ city: z.string() }),
    handler: () => "晴",
  };
}

/** 日志收集：断言 warn 路由用。 */
interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly data: unknown;
}

function makeNode(id: string, type: string, params: Readonly<Record<string, unknown>> = {}): Node {
  const def = registry.get(type);
  return { id, type, name: id, params, inputs: def.inputs, outputs: def.outputs };
}

function createMockContext(node: Node, logs: LogEntry[] = []): NodeExecutionContext {
  const store: Record<string, unknown> = {};
  return {
    node,
    workflowId: "test-wf",
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

const textScript: FakeScriptStep[] = [{ kind: "text", text: "ok" }];

afterEach(() => {
  clearTools();
});

describe("filterToolsByMode", () => {
  test("all：原样返回且保持顺序", () => {
    const tools = [makeTool("demo.weather", "查询天气"), makeTool("demo.foo", "无关功能")];
    expect(filterToolsByMode(tools, "all").map((t) => t.name)).toEqual(["demo.weather", "demo.foo"]);
  });

  test("all：忽略 filter 白名单", () => {
    const tools = [makeTool("demo.weather", "查询天气")];
    expect(filterToolsByMode(tools, "all", ["no.match"]).map((t) => t.name)).toEqual(["demo.weather"]);
  });

  test("subset：白名单命中保留", () => {
    const tools = [makeTool("demo.weather", "查询天气"), makeTool("demo.foo", "无关功能")];
    const filtered = filterToolsByMode(tools, "subset", ["demo.weather"]);
    expect(filtered.map((t) => t.name)).toEqual(["demo.weather"]);
  });

  test("subset：未命中全部剔除", () => {
    const tools = [makeTool("demo.weather", "查询天气")];
    expect(filterToolsByMode(tools, "subset", ["no.match"])).toEqual([]);
  });

  test("subset：filter 缺省返回空", () => {
    const tools = [makeTool("demo.weather", "查询天气")];
    expect(filterToolsByMode(tools, "subset")).toEqual([]);
  });

  test("auto：本身不筛，原样返回", () => {
    const tools = [makeTool("demo.weather", "查询天气"), makeTool("demo.foo", "无关功能")];
    expect(filterToolsByMode(tools, "auto").map((t) => t.name)).toEqual(["demo.weather", "demo.foo"]);
  });
});

describe("relevanceScore", () => {
  const tool = makeTool("demo.getWeather", "查询天气");

  test("工具名关键词命中权重 2", () => {
    expect(relevanceScore(tool, "getWeather")).toBe(2);
  });

  test("描述关键词命中权重 1", () => {
    expect(relevanceScore(tool, "天气")).toBe(1);
  });

  test("多词累加：名 2 + 描述 1", () => {
    expect(relevanceScore(tool, "getWeather 天气")).toBe(3);
  });

  test("无匹配返回 0", () => {
    expect(relevanceScore(tool, "文件")).toBe(0);
  });

  test("空 query 返回 0", () => {
    expect(relevanceScore(tool, "")).toBe(0);
  });
});

describe("selectRelevantTools", () => {
  const tSearch = makeTool("demo.search", "搜索网络信息");
  const tWeb = makeTool("demo.web", "网络工具");
  const tFoo = makeTool("demo.foo", "无关功能");
  const tools = [tSearch, tWeb, tFoo];

  test("按相关度降序返回（maxCount=全部）", () => {
    const selected = selectRelevantTools(tools, "search 网络", tools.length);
    expect(selected.map((t) => t.name)).toEqual(["demo.search", "demo.web", "demo.foo"]);
  });

  test("top K：maxCount=2 取前 2", () => {
    const selected = selectRelevantTools(tools, "search 网络", 2);
    expect(selected.map((t) => t.name)).toEqual(["demo.search", "demo.web"]);
  });

  test("分数 >0 优先，不足补分数 =0 至 maxCount", () => {
    const selected = selectRelevantTools(tools, "search 网络", 3);
    expect(selected.map((t) => t.name)).toEqual(["demo.search", "demo.web", "demo.foo"]);
  });

  test("maxCount ≤ 0 返回空", () => {
    expect(selectRelevantTools(tools, "search", 0)).toEqual([]);
    expect(selectRelevantTools(tools, "search", -1)).toEqual([]);
  });
});

describe("estimateToolsTokens", () => {
  test("空工具集返回 0", () => {
    expect(estimateToolsTokens([])).toBe(0);
  });

  test("按 (name + description) 字符数 / 3 向上取整累加", () => {
    expect(estimateToolsTokens([makeTool("abc", "def")])).toBe(2);
    expect(estimateToolsTokens([makeTool("abcdef", "ghi")])).toBe(3);
    expect(estimateToolsTokens([makeTool("abc", "def"), makeTool("abcdef", "ghi")])).toBe(5);
  });
});

describe("enforceToolBudget", () => {
  const three = [
    makeTool("alpha.big", "天气"),
    makeTool("beta.big", "天气"),
    makeTool("gamma.big", "天气"),
  ];

  test("估算未超预算：原样返回 trimmed=0", () => {
    const result = enforceToolBudget(three, 100, "");
    expect(result.tools).toHaveLength(3);
    expect(result.trimmed).toBe(0);
  });

  test("估算超预算：按相关度裁剪并返回 trimmed 数", () => {
    const result = enforceToolBudget(three, 8, "");
    expect(result.tools).toHaveLength(2);
    expect(result.trimmed).toBe(1);
  });

  test("预算过小：全部裁空", () => {
    const result = enforceToolBudget(three, 1, "");
    expect(result.tools).toEqual([]);
    expect(result.trimmed).toBe(3);
  });
});

describe("ai 节点工具上下文裁剪集成", () => {
  test("toolMode=subset：request.tools 仅白名单工具且模型可调用", async () => {
    let readCalled = false;
    registerTool(weatherTool());
    registerTool({
      name: "web.scraping.read_file",
      description: "读取文件内容",
      parameters: z.object({ path: z.string() }),
      handler: () => {
        readCalled = true;
        return "内容";
      },
    });
    const node = makeNode("ai", "ai", {
      model: {
        provider: "fake",
        model: "test",
        fakeScript: [
          { kind: "tool_call", toolCall: { name: "demo.getWeather", args: { city: "北京" } } },
          { kind: "text", text: "晴" },
        ],
      },
      inputMessages: "北京天气？",
      tools: ["demo.getWeather", "web.scraping.read_file"],
      toolMode: "subset",
      toolFilter: ["demo.getWeather"],
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node)));
    expect(request.tools.map((t) => t.name)).toEqual(["demo.getWeather"]);
    expect(readCalled).toBe(false);
  });

  test("toolMode=auto：按相关度排序且全量保留（无预算）", async () => {
    registerTool(makeTool("demo.search", "搜索网络信息"));
    registerTool(makeTool("demo.weather", "查询天气"));
    registerTool(makeTool("demo.other", "无关功能"));
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "search 网络",
      tools: ["demo.other", "demo.search", "demo.weather"],
      toolMode: "auto",
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node)));
    expect(request.tools.map((t) => t.name)).toEqual(["demo.search", "demo.other", "demo.weather"]);
  });

  test("toolBudget 超限：按相关度裁剪 + logger.warn（kind=tool_budget_trimmed）", async () => {
    registerTool(makeTool("demo.bigA", "查询天气详情，返回温度湿度等气象数据"));
    registerTool(makeTool("demo.bigB", "处理文件内容，包含读取写入删除等操作"));
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "查询 天气 详情",
      tools: ["demo.bigA", "demo.bigB"],
      toolBudget: 10,
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node, logs)));
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]?.name).toBe("demo.bigA");
    const warns = logs.filter((entry) => entry.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("工具上下文超预算");
    expect(warns[0]?.data).toEqual({ kind: "tool_budget_trimmed", trimmed: 1 });
  });

  test("toolBudget 未超限：不 warn、工具全量保留", async () => {
    registerTool(makeTool("demo.bigA", "查询天气详情，返回温度湿度等气象数据"));
    const logs: LogEntry[] = [];
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "查询 天气 详情",
      tools: ["demo.bigA"],
      toolBudget: 100,
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node, logs)));
    expect(request.tools).toHaveLength(1);
    expect(logs.filter((entry) => entry.level === "warn")).toHaveLength(0);
  });

  test("缺省 toolMode=all：既有行为零回归（工具全量保留）", async () => {
    registerTool(weatherTool());
    registerTool(makeTool("demo.other", "无关功能"));
    const node = makeNode("ai", "ai", {
      model: { provider: "fake", model: "test", fakeScript: textScript },
      inputMessages: "你好",
      tools: ["demo.getWeather", "demo.other"],
    });
    const request = await captureRequest(() => aiNode.execute(createMockContext(node)));
    expect(request.tools.map((t) => t.name)).toEqual(["demo.getWeather", "demo.other"]);
  });
});

describe("ai 节点上下文裁剪 params 边界", () => {
  test("toolMode 非法抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { toolMode: "bad" });
    await expect(aiNode.execute(createMockContext(node))).rejects.toThrow(InvalidAIParamsError);
  });

  test("toolBudget ≤ 0 抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { toolBudget: 0 });
    await expect(aiNode.execute(createMockContext(node))).rejects.toThrow(InvalidAIParamsError);
  });

  test("toolBudget 非数字抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { toolBudget: "100" });
    await expect(aiNode.execute(createMockContext(node))).rejects.toThrow(InvalidAIParamsError);
  });

  test("toolFilter 非数组抛 InvalidAIParamsError", async () => {
    const node = makeNode("ai", "ai", { toolFilter: "demo.getWeather" });
    await expect(aiNode.execute(createMockContext(node))).rejects.toThrow(InvalidAIParamsError);
  });
});

describe("param-fields schema 上下文裁剪字段", () => {
  test("aiParamsSchema 含 toolMode/toolFilter/toolBudget", () => {
    const keys = new Set(aiParamsSchema.map((field) => field.key));
    for (const key of ["toolMode", "toolFilter", "toolBudget"]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  test("toolMode select 字段：默认 all + 三选项", () => {
    const field = aiParamsSchema.find((f) => f.key === "toolMode");
    expect(field?.type).toBe("select");
    expect(field?.default).toBe("all");
    expect(field?.options).toEqual([
      { label: "全量（all）", value: "all" },
      { label: "白名单（subset）", value: "subset" },
      { label: "自动（auto）", value: "auto" },
    ]);
  });
});
