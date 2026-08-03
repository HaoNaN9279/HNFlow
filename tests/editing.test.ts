// 编辑态纯函数单测：草稿深拷贝隔离、draft 标记、提交校验、只读态查询。
import { describe, expect, test } from "bun:test";
import type { Edge, Node, Port, PortDirection, PortType, Workflow } from "../src/model/types.js";
import { registry } from "../src/nodes/registry.js";
import {
  commitDraft,
  createDraft,
  DraftCommitError,
  isReadOnly,
  workflowSnapshot,
  type Draft,
  type EngineStateQuery,
} from "../src/editing/index.js";

function makePort(
  id: string,
  name: string,
  type: PortType,
  direction: PortDirection,
  binding?: string,
): Port {
  return {
    id,
    name,
    type,
    direction,
    ...(binding === undefined ? {} : { binding }),
  };
}

function makeNode(
  id: string,
  type: string,
  opts: {
    readonly inputs?: readonly Port[];
    readonly outputs?: readonly Port[];
    readonly params?: Readonly<Record<string, unknown>>;
    readonly subworkflow?: Workflow;
  } = {},
): Node {
  // 非内置类型（如 subflow）用空端口，避免 registry.get 抛 UnknownNodeTypeError。
  const def = registry.has(type) ? registry.get(type) : undefined;
  return {
    id,
    type,
    name: id,
    params: opts.params ?? {},
    inputs: opts.inputs ?? def?.inputs ?? [],
    outputs: opts.outputs ?? def?.outputs ?? [],
    ...(opts.subworkflow === undefined ? {} : { subworkflow: opts.subworkflow }),
  };
}

function makeWorkflow(
  nodes: readonly Node[],
  edges: readonly Edge[],
  globalVariables?: Readonly<Record<string, unknown>>,
): Workflow {
  return {
    id: "wf",
    name: "wf",
    version: "0.1.0",
    nodes,
    edges,
    ...(globalVariables === undefined ? {} : { globalVariables }),
  };
}

describe("isReadOnly / workflowSnapshot 引擎状态查询", () => {
  test("isReadOnly 返回引擎只读标记", () => {
    const engine: EngineStateQuery = { isReadOnly: true, workflowSnapshot: makeWorkflow([], []) };
    expect(isReadOnly(engine)).toBe(true);
    expect(isReadOnly({ ...engine, isReadOnly: false })).toBe(false);
  });

  test("workflowSnapshot 透传引擎快照", () => {
    const snapshot = makeWorkflow([makeNode("a", "start")], []);
    const engine: EngineStateQuery = { isReadOnly: false, workflowSnapshot: snapshot };
    expect(workflowSnapshot(engine)).toBe(snapshot);
  });
});

describe("createDraft 深拷贝隔离", () => {
  test("修改 draft 的 node.params 不影响原图", () => {
    const workflow = makeWorkflow(
      [makeNode("a", "start", { params: { target: { value: 1 } } })],
      [],
    );
    const draft = createDraft(workflow);
    const draftNode = draft.nodes[0];
    if (draftNode === undefined) throw new Error("draft node missing");
    const draftParams = draftNode.params as { target: { value: number } };
    draftParams.target.value = 999;
    expect(workflow.nodes[0]?.params).toEqual({ target: { value: 1 } });
  });

  test("修改嵌套 subworkflow 内节点不影响原图", () => {
    const inner = makeWorkflow([makeNode("inner-a", "start", { params: { mode: "prod" } })], []);
    const workflow = makeWorkflow([makeNode("outer", "subflow", { subworkflow: inner })], []);
    const draft = createDraft(workflow);
    const outer = draft.nodes[0];
    if (outer === undefined || outer.subworkflow === undefined) {
      throw new Error("draft subworkflow missing");
    }
    const innerNode = outer.subworkflow.nodes[0];
    if (innerNode === undefined) throw new Error("inner node missing");
    const innerParams = innerNode.params as { mode: string };
    innerParams.mode = "dev";
    expect(workflow.nodes[0]?.subworkflow?.nodes[0]?.params).toEqual({ mode: "prod" });
  });

  test("draft 与原图不共享 node.params 对象引用", () => {
    const workflow = makeWorkflow(
      [makeNode("a", "start", { params: { config: { retries: 3 } } })],
      [],
    );
    const draft = createDraft(workflow);
    expect(draft.nodes[0]?.params).not.toBe(workflow.nodes[0]?.params);
    const draftParams = draft.nodes[0]?.params as { config: { retries: number } };
    draftParams.config.retries = 99;
    expect(workflow.nodes[0]?.params).toEqual({ config: { retries: 3 } });
  });
});

describe("createDraft 标记", () => {
  test("id 带 -draft 后缀、draftOf 指向原 id、version 以 draft- 开头", () => {
    const workflow = makeWorkflow([makeNode("a", "start")], []);
    const draft = createDraft(workflow);
    expect(draft.id).toBe("wf-draft");
    expect(draft.draftOf).toBe("wf");
    expect(draft.version.startsWith("draft-")).toBe(true);
    expect(draft.name).toBe("wf");
  });
});

describe("commitDraft 提交", () => {
  test("成功：元信息继承 original，内容为 draft，无 draftOf 字段", () => {
    const original = makeWorkflow([makeNode("a", "start")], []);
    const draft: Draft = {
      ...makeWorkflow(
        [makeNode("a", "start", { params: { mode: "v2" } }), makeNode("b", "end")],
        [],
        { k: 2 },
      ),
      id: "wf-draft",
      version: "draft-1",
      draftOf: "wf",
    };
    const committed = commitDraft(draft, original);
    expect(committed.id).toBe("wf");
    expect(committed.name).toBe("wf");
    expect(committed.version).toBe("0.1.0");
    expect(committed.nodes).toEqual(draft.nodes);
    expect(committed.edges).toEqual(draft.edges);
    expect(committed.globalVariables).toEqual({ k: 2 });
    expect("draftOf" in committed).toBe(false);
  });

  test("失败：draftOf 与 original 不匹配 → DraftCommitError", () => {
    const original = makeWorkflow([makeNode("a", "start")], []);
    const draft: Draft = {
      ...makeWorkflow([makeNode("a", "start")], []),
      id: "wf-draft",
      version: "draft-1",
      draftOf: "other-wf",
    };
    expect(() => commitDraft(draft, original)).toThrow(DraftCommitError);
  });

  test("失败：draft 有环 → DraftCommitError", () => {
    const original = makeWorkflow([makeNode("a", "start")], []);
    const out = makePort("out", "out", "any", "out");
    const inPort = makePort("in", "in", "any", "in");
    const cyclic = makeWorkflow(
      [
        makeNode("a", "start", { outputs: [out] }),
        makeNode("b", "setVariable", { inputs: [inPort], outputs: [out] }),
      ],
      [
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePortId: "out",
          targetNodeId: "b",
          targetPortId: "in",
        },
        {
          id: "e2",
          sourceNodeId: "b",
          sourcePortId: "out",
          targetNodeId: "a",
          targetPortId: "in",
        },
      ],
    );
    const draft: Draft = { ...cyclic, id: "wf-draft", version: "draft-1", draftOf: "wf" };
    expect(() => commitDraft(draft, original)).toThrow(DraftCommitError);
  });

  test("失败：嵌套 subworkflow 有环 → DraftCommitError（递归校验）", () => {
    const original = makeWorkflow([makeNode("a", "start")], []);
    const out = makePort("out", "out", "any", "out");
    const inPort = makePort("in", "in", "any", "in");
    const cyclicInner = makeWorkflow(
      [
        makeNode("x", "start", { outputs: [out] }),
        makeNode("y", "setVariable", { inputs: [inPort], outputs: [out] }),
      ],
      [
        {
          id: "e1",
          sourceNodeId: "x",
          sourcePortId: "out",
          targetNodeId: "y",
          targetPortId: "in",
        },
        {
          id: "e2",
          sourceNodeId: "y",
          sourcePortId: "out",
          targetNodeId: "x",
          targetPortId: "in",
        },
      ],
    );
    const draft: Draft = {
      ...makeWorkflow([makeNode("outer", "subflow", { subworkflow: cyclicInner })], []),
      id: "wf-draft",
      version: "draft-1",
      draftOf: "wf",
    };
    expect(() => commitDraft(draft, original)).toThrow(DraftCommitError);
  });
});
