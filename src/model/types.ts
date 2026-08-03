// 核心领域类型契约（HNFlow 图模型）
// 全项目共享，其他模块从这里 import。

export type PortType = "string" | "number" | "boolean" | "any";
export type PortDirection = "in" | "out";

export interface Port {
  readonly id: string;
  readonly name: string;
  readonly type: PortType;
  readonly direction: PortDirection;
  readonly binding?: string; // 变量路径，格式 "scope:key"
}

export interface Node {
  readonly id: string;
  readonly type: string; // 节点类型标识，如 "start" | "end" | "ifElse" | "setVariable"
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputs: readonly Port[];
  readonly outputs: readonly Port[];
  readonly position?: { readonly x: number; readonly y: number };
}

export interface Edge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly sourcePortId: string;
  readonly targetNodeId: string;
  readonly targetPortId: string;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly globalVariables?: Readonly<Record<string, unknown>>;
}

export type ScopeName = "global" | "workflow" | `node:${string}`;
export type VariablePath = string; // 格式 "scope:key"
