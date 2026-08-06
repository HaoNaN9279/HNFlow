// T7 validateConnection 纯逻辑单测（无 DOM/X6 依赖，bun test 直跑）。
// 运行方式：apps/desktop/renderer 下 `bun test src/editor/__tests__/edge-connect.test.ts`。
// 顶部 triple-slash 引用 bun 类型：本文件位于 renderer/src（tsconfig types 仅 vite/client），
// 显式加载 bun-types 使 tsc 能解析 "bun:test" 模块。
/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { Edge, PortType } from "@core/model/types";
import { describeEdgeTargets, validateConnection } from "../edge-connect.js";

/** 构造输出端点（默认 type=any）。 */
function out(nodeId: string, portId: string, portType: PortType = "any") {
  return { nodeId, portId, portType, direction: "out" as const };
}

/** 构造输入端点（默认 type=any）。 */
function input(nodeId: string, portId: string, portType: PortType = "any") {
  return { nodeId, portId, portType, direction: "in" as const };
}

/** 便捷构造边：source 端口固定 out、target 端口固定 in。 */
function edge(id: string, sourceNodeId: string, targetNodeId: string): Edge {
  return { id, sourceNodeId, sourcePortId: "out", targetNodeId, targetPortId: "in" };
}

describe("validateConnection", () => {
  it("端口类型兼容时放行", () => {
    expect(validateConnection(out("A", "out", "string"), input("B", "in", "string"), []).ok).toBe(true);
  });
  it("any 兼容任意类型（source=any / target=any）", () => {
    expect(validateConnection(out("A", "out", "any"), input("B", "in", "number"), []).ok).toBe(true);
    expect(validateConnection(out("A", "out", "number"), input("B", "in", "any"), []).ok).toBe(true);
  });
  it("类型不兼容时拒绝并给出中文原因", () => {
    const result = validateConnection(out("A", "out", "string"), input("B", "in", "number"), []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("端口类型不兼容：string → number");
  });
  it("禁止自连（同节点）", () => {
    const result = validateConnection(out("A", "out"), input("A", "in"), []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("不能连接到自身");
  });
  it("输入端口已被占用时拒绝", () => {
    const edges = [edge("e1", "A", "B")];
    const result = validateConnection(out("C", "out"), input("B", "in"), edges);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("输入端口已连接：B.in");
  });
  it("同节点不同输入端口可连", () => {
    const edges = [edge("e1", "A", "B")];
    expect(validateConnection(out("C", "out"), input("B", "in2"), edges).ok).toBe(true);
  });
  it("已存在 A→B 时拒绝反向 B→A", () => {
    const edges = [edge("e1", "A", "B")];
    const result = validateConnection(out("B", "out"), input("A", "in"), edges);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("已存在反向连线，不能形成环");
  });
  it("可达性成环时拒绝（A→B、B→C 后新增 C→A）", () => {
    const edges = [edge("e1", "A", "B"), edge("e2", "B", "C")];
    const result = validateConnection(out("C", "out"), input("A", "in"), edges);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("该连线会形成环，不允许连接");
  });
  it("不成环的连线放行", () => {
    const edges = [edge("e1", "A", "B")];
    expect(validateConnection(out("C", "out"), input("D", "in"), edges).ok).toBe(true);
  });
  it("方向错误拒绝：source 为 in 端口", () => {
    const result = validateConnection(input("A", "in"), input("B", "in"), []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("连线方向错误：只能从输出端口开始连线");
  });
  it("方向错误拒绝：target 为 out 端口", () => {
    const result = validateConnection(out("A", "out"), out("B", "out"), []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("连线方向错误：只能连接到输入端口");
  });
  it("缺省方向字段时跳过方向校验（最小签名兼容）", () => {
    const result = validateConnection(
      { nodeId: "A", portId: "out", portType: "string" },
      { nodeId: "B", portId: "in", portType: "string" },
      [],
    );
    expect(result.ok).toBe(true);
  });
});

describe("describeEdgeTargets", () => {
  it("输出 节点.端口", () => {
    expect(describeEdgeTargets(edge("e1", "A", "B"))).toBe("B.in");
  });
});
