// 节点注册表：按 type 注册/查询节点定义，模块加载时注册全部内置节点。

import type { INodeDefinition } from "../execution/types.js";
import { commandNode } from "./command.js";
import { endNode } from "./end.js";
import { fileNode } from "./file.js";
import { httpNode } from "./http.js";
import { humanTaskNode } from "./humanTask.js";
import { ifElseNode } from "./ifElse.js";
import { logNode } from "./log.js";
import { setVariableNode } from "./setVariable.js";
import { startNode } from "./start.js";
import { subworkflowNode } from "./subworkflow.js";

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

export const builtinNodes: INodeDefinition[] = [
  startNode,
  endNode,
  ifElseNode,
  setVariableNode,
  commandNode,
  httpNode,
  fileNode,
  logNode,
  humanTaskNode,
  subworkflowNode,
];

export const registry = new NodeRegistry();
builtinNodes.forEach((def) => registry.register(def));
