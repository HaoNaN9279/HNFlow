// 节点执行接口契约。
// Node / Port / VariablePath 来自 model 层（T2），此处仅消费，不重复定义。
// NodeExecutionContext 由 T4 的 WorkflowContext 实现，T5/T7 据此消费。

import type { HumanTaskStoreLike } from "../db/stores/types.js";
import type { HumanTaskSpec } from "../human/types.js";
import type { Node, Port, VariablePath } from "../model/types.js";

/**
 * 节点定义：引擎按 type 查注册表获得执行逻辑。
 * execute 返回输出端口值映射 { outputPortId: value }。
 */
export interface INodeDefinition {
  /** 节点类型标识 */
  type: string;
  /** 展示名 */
  name: string;
  /** 默认端口模板 */
  inputs: Port[];
  outputs: Port[];
  /** 执行当前节点，返回输出端口值映射 {outputPortId: value} */
  execute(ctx: NodeExecutionContext): Promise<Record<string, unknown>>;
}

/**
 * 节点执行上下文（最小化契约）。
 * 三级作用域读写（T4 实现）：scope ∈ "global" | "workflow" | `node:${string}`；
 * path 为 "scope:key" 形式。
 */
export interface NodeExecutionContext {
  /** 当前执行的节点 */
  node: Node;
  workflowId: string;
  /** 引擎注入的人工任务存储（subworkflow 节点透传给子引擎复用，保证跨重启任务可查）。 */
  readonly humanTaskStore?: HumanTaskStoreLike;
  /** 读取指定作用域下的变量 */
  get(scope: string, key: string): unknown;
  /** 写入指定作用域下的变量 */
  set(scope: string, key: string, value: unknown): void;
  /** 按 "scope:key" 路径读取变量 */
  getByPath(path: VariablePath): unknown;
  /** 按 "scope:key" 路径写入变量 */
  setByPath(path: VariablePath, value: unknown): void;
  /** 读取指定作用域下的全部变量快照 */
  getAll(scope: string): Record<string, unknown>;
  /** 请求人工介入：引擎捕获该信号并挂起当前工作流。返回 never 表示调用后节点执行不会正常返回。 */
  suspend(spec: HumanTaskSpec): never;
  logger: NodeLogger;
}

/** 节点日志接口：由引擎注入结构化日志器。 */
export interface NodeLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}
