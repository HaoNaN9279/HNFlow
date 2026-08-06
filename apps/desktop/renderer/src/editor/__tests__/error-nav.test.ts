// 验收 5 错误导航纯函数单测（无 DOM/X6 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/editor/__tests__/error-nav.test.ts`。
// 顶部 triple-slash 引用 bun 类型：本文件位于 renderer/src（tsconfig types 仅 vite/client），
// 显式加载 bun-types 使 tsc 能解析 "bun:test" 模块。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { EditorGraph, EditorGraphNode } from "@core/editing/editor-graph";
import { NODE_PATH_SEPARATOR, parseNodePath, planErrorNavigation } from "../error-nav.js";

/** 便捷构造节点：无 subworkflow 为普通 command 节点；有 subworkflow 为内嵌子工作流节点。 */
function node(id: string, name: string, subworkflow?: EditorGraph): EditorGraphNode {
  return {
    id,
    type: subworkflow === undefined ? "command" : "subworkflow",
    name,
    params: {},
    inputs: [],
    outputs: [],
    position: { x: 0, y: 0 },
    ...(subworkflow === undefined ? {} : { subworkflow }),
  };
}

/** 便捷构造图（无边）。 */
function graph(nodes: readonly EditorGraphNode[]): EditorGraph {
  return { nodes, edges: [] };
}

/** 组合节点路径（与核心库 formatNodePath 同构）。 */
function path(...segments: readonly string[]): string {
  return segments.join(NODE_PATH_SEPARATOR);
}

/** 模板引用节点：subworkflow 类型但无内嵌子图（内容在模板库，不可深入）。 */
function templateRefNode(id: string, name: string): EditorGraphNode {
  return { id, type: "subworkflow", name, params: {}, inputs: [], outputs: [], position: { x: 0, y: 0 } };
}

describe("parseNodePath", () => {
  it("按分隔符分段并去空白段", () => {
    expect(parseNodePath(path("顶层工作流", "A", "B"))).toEqual(["顶层工作流", "A", "B"]);
  });
  it("空路径返回空数组", () => {
    expect(parseNodePath("")).toEqual([]);
    expect(parseNodePath("   ")).toEqual([]);
  });
});

describe("planErrorNavigation", () => {
  const inner = graph([node("leaf-1", "资源导入")]);
  const outer = graph([node("c-1", "发布子流程", inner), node("n-1", "普通节点")]);
  const top = graph([node("c-0", "容器1", outer), node("leaf-0", "顶层叶子")]);

  it("顶层叶子：containerNames 空，直接定位", () => {
    const plan = planErrorNavigation(top, path("顶层工作流", "顶层叶子"));
    expect(plan.kind).toBe("ok");
    if (plan.kind === "ok") {
      expect(plan.containerNames).toEqual([]);
      expect(plan.leaf).toEqual({ id: "leaf-0", name: "顶层叶子" });
    }
  });

  it("多层：逐层进入容器后定位叶子", () => {
    const plan = planErrorNavigation(top, path("顶层工作流", "容器1", "发布子流程", "资源导入"));
    expect(plan.kind).toBe("ok");
    if (plan.kind === "ok") {
      expect(plan.containerNames).toEqual(["容器1", "发布子流程"]);
      expect(plan.leaf).toEqual({ id: "leaf-1", name: "资源导入" });
    }
  });

  it("容器段按原始 id 匹配（resolveName 回退场景）", () => {
    const plan = planErrorNavigation(top, path("顶层工作流", "c-0", "发布子流程", "资源导入"));
    expect(plan.kind).toBe("ok");
    if (plan.kind === "ok") {
      expect(plan.containerNames).toEqual(["c-0", "发布子流程"]);
      expect(plan.leaf).toEqual({ id: "leaf-1", name: "资源导入" });
    }
  });

  it("模板引用容器（subworkflow 缺失）→ blocked 定位入口", () => {
    const graphWithTpl = graph([node("c-0", "容器1", graph([templateRefNode("tpl-1", "模板容器")]))]);
    const plan = planErrorNavigation(graphWithTpl, path("顶层工作流", "容器1", "模板容器", "内部节点"));
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blocked).toEqual({ id: "tpl-1", name: "模板容器" });
    }
  });

  it("容器不是 subworkflow（普通节点当容器）→ blocked 定位该节点", () => {
    const plan = planErrorNavigation(top, path("顶层工作流", "容器1", "普通节点", "子节点"));
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blocked).toEqual({ id: "n-1", name: "普通节点" });
    }
  });

  it("容器在当前层找不到 → notFound", () => {
    const plan = planErrorNavigation(top, path("顶层工作流", "不存在的容器", "子节点"));
    expect(plan.kind).toBe("notFound");
  });

  it("叶子在当前层找不到 → notFound", () => {
    const plan = planErrorNavigation(top, path("顶层工作流", "不存在的叶子"));
    expect(plan.kind).toBe("notFound");
  });

  it("空路径 / 只有根前缀 → notFound", () => {
    expect(planErrorNavigation(top, "").kind).toBe("notFound");
    expect(planErrorNavigation(top, "顶层工作流").kind).toBe("notFound");
  });

  it("路径不以根前缀开头时同样解析（防御格式漂移）", () => {
    const plan = planErrorNavigation(top, path("容器1", "发布子流程"));
    expect(plan.kind).toBe("ok");
    if (plan.kind === "ok") {
      expect(plan.containerNames).toEqual(["容器1"]);
      expect(plan.leaf).toEqual({ id: "c-1", name: "发布子流程" });
    }
  });
});
