// 工具类型层测试：命名空间、langchain 转换、引用解析。
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  applyNamespace,
  resolveToolReferences,
  toLangChainTool,
  UnknownToolReferenceError,
} from "../src/ai/tool.js";
import type { HNFlowTool } from "../src/ai/types.js";

/** 构造测试工具：同步 handler 回显 query。 */
function makeTool(name: string): HNFlowTool {
  return {
    name,
    description: `${name} 工具`,
    parameters: z.object({ query: z.string() }),
    handler: (input) => `结果: ${input["query"] ?? ""}`,
  };
}

describe("applyNamespace", () => {
  test("无 namespace 返回原名", () => {
    expect(applyNamespace("navigate")).toBe("navigate");
  });

  test("有 namespace 拼接前缀", () => {
    expect(applyNamespace("navigate", "web")).toBe("web.navigate");
  });

  test("空串 namespace 不加前缀", () => {
    expect(applyNamespace("navigate", "")).toBe("navigate");
  });

  test("undefined namespace 不加前缀", () => {
    expect(applyNamespace("navigate", undefined)).toBe("navigate");
  });
});

describe("toLangChainTool", () => {
  test("转换后 name/description 保留，invoke 调用 handler", async () => {
    const hfTool = makeTool("demo.getWeather");
    const lcTool = toLangChainTool(hfTool);
    expect(lcTool.name).toBe("demo.getWeather");
    expect(lcTool.description).toBe("demo.getWeather 工具");
    const result = await lcTool.invoke({ query: "北京" });
    expect(result).toBe("结果: 北京");
  });

  test("异步 handler 同样生效", async () => {
    const hfTool: HNFlowTool = {
      name: "async.tool",
      description: "异步工具",
      parameters: z.object({ n: z.number() }),
      handler: async (input) => `翻倍: ${(input["n"] as number) * 2}`,
    };
    const result = await toLangChainTool(hfTool).invoke({ n: 21 });
    expect(result).toBe("翻倍: 42");
  });
});

describe("resolveToolReferences", () => {
  test("全部命中返回对应工具，顺序与引用一致", () => {
    const a = makeTool("demo.a");
    const b = makeTool("demo.b");
    const available = new Map([
      ["demo.a", a],
      ["demo.b", b],
    ]);
    expect(resolveToolReferences(["demo.b", "demo.a"], available)).toEqual([b, a]);
  });

  test("缺失引用抛 UnknownToolReferenceError", () => {
    const available = new Map([["demo.a", makeTool("demo.a")]]);
    expect(() => resolveToolReferences(["demo.a", "demo.missing"], available)).toThrow(
      UnknownToolReferenceError,
    );
  });

  test("缺失错误携带缺失名", () => {
    const available = new Map<string, HNFlowTool>();
    try {
      resolveToolReferences(["no.such"], available);
      throw new Error("应已抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownToolReferenceError);
      if (err instanceof UnknownToolReferenceError) {
        expect(err.missingName).toBe("no.such");
      }
    }
  });
});
