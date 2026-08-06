// 节点注册表：按 type 注册/查询节点定义，模块加载时注册全部内置节点。

import type { INodeDefinition } from "../execution/types.js";
import { aiNode } from "./ai.js";
import { commandNode } from "./command.js";
import { endNode } from "./end.js";
import { fileNode } from "./file.js";
import { finallyNode } from "./finallyNode.js";
import { httpNode } from "./http.js";
import { humanTaskNode } from "./humanTask.js";
import { ifElseNode } from "./ifElse.js";
import { llmNode } from "./llm.js";
import { logNode } from "./log.js";
import { mcpToolNode } from "./mcpTool.js";
import { loopNode } from "./loop.js";
import { parallelNode } from "./parallel.js";
import { setVariableNode } from "./setVariable.js";
import { startNode } from "./start.js";
import { subworkflowNode } from "./subworkflow.js";
import { tryCatchNode } from "./tryCatch.js";

/** 重复注册同一 type */
export class DuplicateNodeTypeError extends Error {
  readonly name = "DuplicateNodeTypeError";

  constructor(readonly nodeType: string) {
    super(`node type already registered: "${nodeType}"`);
  }
}

/** 查询未注册的 type */
export class UnknownNodeTypeError extends Error {
  readonly name = "UnknownNodeTypeError";

  constructor(readonly nodeType: string) {
    super(`unknown node type: "${nodeType}"`);
  }
}

export class NodeRegistry {
  private readonly definitions = new Map<string, INodeDefinition>();

  register(def: INodeDefinition): void {
    if (this.definitions.has(def.type)) {
      throw new DuplicateNodeTypeError(def.type);
    }
    this.definitions.set(def.type, def);
  }

  get(type: string): INodeDefinition {
    const def = this.definitions.get(type);
    if (def === undefined) {
      throw new UnknownNodeTypeError(type);
    }
    return def;
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  list(): string[] {
    return [...this.definitions.keys()];
  }
}

// v0.2.5 T2 幂等标注：集中标注 17 个内置节点的 idempotent。
// false=有副作用/非幂等（重复执行产生脏数据）：command（执行命令）、http（发请求）、
// mcpTool（调用 MCP Server 工具，外部副作用）、
// file（读写文件）、llm/ai（模型调用，消耗 token/产生外部影响）。
// true=纯函数/可安全重跑：start/end/setVariable/ifElse/log/tryCatch/finally/subworkflow/loop/parallel
// （容器与调度逻辑无副作用，副作用在子图节点上按各自标注判定）；
// humanTask 挂起节点标 true——它不产生副作用仅等待人工介入，重跑不产生重复外部影响。
export const builtinNodes: INodeDefinition[] = [
  { ...startNode, idempotent: true },
  { ...endNode, idempotent: true },
  { ...ifElseNode, idempotent: true },
  { ...setVariableNode, idempotent: true },
  { ...commandNode, idempotent: false },
  { ...httpNode, idempotent: false },
  { ...mcpToolNode, idempotent: false },
  { ...fileNode, idempotent: false },
  { ...logNode, idempotent: true },
  { ...humanTaskNode, idempotent: true },
  { ...subworkflowNode, idempotent: true },
  { ...aiNode, idempotent: false },
  { ...llmNode, idempotent: false },
  { ...tryCatchNode, idempotent: true },
  { ...finallyNode, idempotent: true },
  { ...loopNode, idempotent: true },
  { ...parallelNode, idempotent: true },
];

export const registry = new NodeRegistry();
builtinNodes.forEach((def) => registry.register(def));
