// AI 工作流生成器单测：合法计划转换、name→id 边映射、非法计划报错、工具工厂。
import { describe, expect, test } from "bun:test";
import {
  availableNodeKinds,
  createGenerateWorkflowTool,
  generateWorkflowFromPlan,
  WorkflowGenerationError,
} from "../src/agent/workflow-generator.js";
import { validateWorkflow } from "../src/model/validate.js";

describe("availableNodeKinds", () => {
  test("包含全部可生成类型与 reviewRequired 审核说明", () => {
    const kinds = availableNodeKinds();
    for (const type of ["command", "http", "file", "setVariable", "log", "ifElse"]) {
      expect(kinds).toContain(type);
    }
    expect(kinds).toContain("reviewRequired");
    expect(kinds).toContain("generatedBy");
  });
});

describe("generateWorkflowFromPlan 合法计划", () => {
  test("command/http/setVariable 链：通过校验、有 start/end、command 标记审核、id 为 n1/n2/n3", () => {
    const plan = {
      workflowName: "示例",
      nodes: [
        { type: "command", name: "执行构建", params: { command: "bun build" } },
        { type: "http", name: "上报结果", params: { url: "https://example.com/api", method: "POST" } },
        { type: "setVariable", name: "记录状态", params: { target: "workflow:status", value: "done" } },
      ],
      edges: [],
    };
    const workflow = generateWorkflowFromPlan(plan, "我的工作流");
    expect(workflow.name).toBe("我的工作流");
    expect(workflow.id.length).toBeGreaterThan(0);
    expect(validateWorkflow(workflow).ok).toBe(true);
    expect(workflow.nodes.some((n) => n.type === "start")).toBe(true);
    expect(workflow.nodes.some((n) => n.type === "end")).toBe(true);

    const cmd = workflow.nodes.find((n) => n.type === "command");
    expect(cmd).toBeDefined();
    expect(cmd?.params["reviewRequired"]).toBe(true);
    expect(cmd?.params["generatedBy"]).toBe("ai");
    expect(workflow.nodes.find((n) => n.name === "执行构建")?.id).toBe("n1");
    expect(workflow.nodes.find((n) => n.name === "上报结果")?.id).toBe("n2");
    expect(workflow.nodes.find((n) => n.name === "记录状态")?.id).toBe("n3");
  });

  test("边引用 name 正确映射 id（http → ifElse）", () => {
    const plan = {
      nodes: [
        { type: "http", name: "拉取数据", params: { url: "https://example.com/x" } },
        {
          type: "ifElse",
          name: "数据判断",
          params: { condition: { variable: "workflow:data", op: "eq", value: "ok" } },
        },
      ],
      edges: [{ from: "拉取数据", to: "数据判断" }],
    };
    const workflow = generateWorkflowFromPlan(plan);
    expect(validateWorkflow(workflow).ok).toBe(true);
    const edge = workflow.edges.find((e) => e.sourceNodeId === "n1");
    expect(edge).toBeDefined();
    expect(edge?.targetNodeId).toBe("n2");
    expect(edge?.sourcePortId).toBe("status");
    expect(edge?.targetPortId).toBe("in");
    // 终点自动补边：n2（ifElse）无出边 → end。
    const toEnd = workflow.edges.find((e) => e.targetNodeId === "end");
    expect(toEnd?.sourceNodeId).toBe("n2");
  });

  test("ifElse 起点自动连 start（有输入端口且无入边）", () => {
    const plan = {
      nodes: [
        { type: "ifElse", name: "判断", params: { condition: { variable: "workflow:a", op: "eq", value: 1 } } },
        { type: "log", name: "收尾", params: { message: "done" } },
      ],
      edges: [],
    };
    const workflow = generateWorkflowFromPlan(plan);
    expect(validateWorkflow(workflow).ok).toBe(true);
    const fromStart = workflow.edges.find((e) => e.sourceNodeId === "start");
    expect(fromStart?.targetNodeId).toBe("n1");
  });
});

describe("generateWorkflowFromPlan 非法计划", () => {
  test("缺 type → 计划格式非法", () => {
    expect(() => generateWorkflowFromPlan({ nodes: [{ name: "x" }], edges: [] })).toThrow(
      WorkflowGenerationError,
    );
    expect(() => generateWorkflowFromPlan({ nodes: [{ name: "x" }], edges: [] })).toThrow(/计划格式非法/);
  });

  test("未知类型 → 明确中文错误", () => {
    expect(() => generateWorkflowFromPlan({ nodes: [{ type: "loop", name: "x" }], edges: [] })).toThrow(
      /不支持的节点类型 "loop"/,
    );
  });

  test("边引用不存在的节点 → 明确中文错误", () => {
    expect(() =>
      generateWorkflowFromPlan({
        nodes: [{ type: "command", name: "a", params: { command: "echo" } }],
        edges: [{ from: "a", to: "ghost" }],
      }),
    ).toThrow(/不存在的节点/);
  });

  test("边目标无输入端口 → 明确中文错误", () => {
    expect(() =>
      generateWorkflowFromPlan({
        nodes: [
          { type: "http", name: "请求", params: { url: "https://example.com" } },
          { type: "command", name: "命令", params: { command: "echo" } },
        ],
        edges: [{ from: "请求", to: "命令" }],
      }),
    ).toThrow(/无输入端口/);
  });

  test("环 → 校验失败", () => {
    expect(() =>
      generateWorkflowFromPlan({
        nodes: [
          { type: "ifElse", name: "a", params: { condition: { variable: "workflow:x", op: "eq", value: 1 } } },
        ],
        edges: [{ from: "a", to: "a" }],
      }),
    ).toThrow(/工作流校验失败/);
  });

  test("空节点列表 → 报错", () => {
    expect(() => generateWorkflowFromPlan({ nodes: [], edges: [] })).toThrow(WorkflowGenerationError);
    expect(() => generateWorkflowFromPlan({ nodes: [], edges: [] })).toThrow(/节点列表不能为空/);
  });
});

describe("createGenerateWorkflowTool", () => {
  test("返回 { workflow, summary }：workflow 可校验、summary 含节点数统计", () => {
    const tool = createGenerateWorkflowTool();
    expect(tool.name).toBe("generate_workflow");
    expect(tool.description).toContain("根据用户自然语言需求生成可执行工作流");
    const result = tool.handler({
      nodes: [{ type: "command", name: "cmd", params: { command: "echo hi" } }],
      edges: [],
    }) as { workflow: ReturnType<typeof generateWorkflowFromPlan>; summary: { nodeCount: number } };
    expect(validateWorkflow(result.workflow).ok).toBe(true);
    expect(result.summary.nodeCount).toBe(3); // command + start + end
    expect(result.workflow.nodes.find((n) => n.type === "command")?.params["reviewRequired"]).toBe(true);
  });

  test("parameters 为 workflowPlanSchema，非法输入走生成错误", () => {
    const tool = createGenerateWorkflowTool();
    const parsed = tool.parameters.safeParse({ nodes: [], edges: [] });
    expect(parsed.success).toBe(false);
  });
});
