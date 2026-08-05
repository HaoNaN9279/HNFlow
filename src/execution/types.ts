// 节点执行接口契约。
// Node / Port / VariablePath 来自 model 层（T2），此处仅消费，不重复定义。
// NodeExecutionContext 由 T4 的 WorkflowContext 实现，T5/T7 据此消费。

import type { SqliteDatabase } from "../db/index.js";
import type { HumanTaskStoreLike } from "../db/stores/types.js";
import type { HumanTaskSpec } from "../human/types.js";
import type { Node, Port, VariablePath } from "../model/types.js";
// type-only import：仅编译期使用，避免与 nodes/registry.ts（import execution/types）形成运行时循环依赖。
import type { NodeRegistry } from "../nodes/registry.js";
import type { DebugController } from "./DebugController.js";
import type { MergedGroups } from "../groups/merge.js";
// re-export（v0.3.1 T5）：Engine 消费 MergedGroups 时经本文件取（type-only，无运行时循环）。
export type { MergedGroups };

/**
 * 节点定义：引擎按 type 查注册表获得执行逻辑。
 * execute 返回输出端口值映射 { outputPortId: value }。
 */
export interface INodeDefinition {
  /** 节点类型标识 */
  type: string;
  /** 展示名 */
  name: string;
  /**
   * 幂等标记（v0.2.5 T2）：true=纯函数/可安全重跑，重复执行不产生脏数据；
   * false=有副作用/非幂等（写文件/发请求/执行命令/模型调用等），重跑会产生重复副作用。
   * 缺省视为 true。T4 崩溃转人工确认据此判定：幂等键开启时非幂等节点 Failed → 转人工。
   */
  idempotent?: boolean;
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
  /** 引擎 runId（v0.2.5 T4）：子图容器透传给子引擎，子图内任务 runId 与父一致（崩溃确认查重）。 */
  readonly runId?: string;
  /** 幂等键（v0.2.5 T4）：子图容器透传给子引擎，子图内崩溃转人工判定用。 */
  readonly idempotencyKey?: string;
  /** AI 中断 checkpoint 持久化配置（ai 节点 interrupt 时注入，T5.1 修复）。 */
  readonly aiCheckpoint?: { readonly dbPath: string; readonly sharedDb?: SqliteDatabase };
  /** 引擎节点注册表：子图容器（loop/tryCatch/subworkflow/finally）透传给子引擎（自定义节点扩展用）。 */
  readonly registry?: NodeRegistry;
  /** 引擎调试控制器：子图容器（subworkflow/loop/tryCatch/finally/parallel）透传给子引擎（单步透传用）。 */
  readonly debugController?: DebugController;
  /** 已加载并合并的功能组（v0.3.1 T5）：节点声明 capabilityGroups 时注入；无声明/未配置则不注入。 */
  readonly activeGroups?: MergedGroups;
  /** 功能组根目录（v0.3.1 T5 子图透传）：子图容器转发给子引擎 options，嵌套子图按同样配置运行时加载。 */
  readonly groupsRootDir?: string;
  /** 功能组缓存容量（v0.3.1 T5 子图透传）：子图容器转发给子引擎 options，缺省子引擎默认 32。 */
  readonly groupCacheMaxSize?: number;
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
  /** 节点执行进度持久化钩子：子图容器节点（loop）每迭代完成后调用，引擎据此落盘断点快照。 */
  readonly progress?: (snapshot: unknown) => Promise<void>;
  logger: NodeLogger;
}

/** 节点日志接口：由引擎注入结构化日志器。 */
export interface NodeLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}
