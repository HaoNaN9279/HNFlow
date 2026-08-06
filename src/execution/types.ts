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
// type-only import：MCP 进程池仅供 AI 节点消费（v0.4.2 D2），避免与 mcp/pool 运行时耦合。
import type { McpServerPool } from "../mcp/pool.js";
// re-export（v0.3.1 T5）：Engine 消费 MergedGroups 时经本文件取（type-only，无运行时循环）。
export type { MergedGroups };
// re-export（v0.4.2 D2）：Engine 消费 MCP 进程池类型时经本文件取（type-only，无运行时循环）。
export type { McpServerPool } from "../mcp/pool.js";

/** 参数面板字段类型（v0.4.0 T1）：编辑器可视化配置面板据此渲染控件。 */
export type ParamFieldType = "string" | "number" | "boolean" | "select" | "textarea" | "json";

/**
 * 参数面板字段声明：key/默认值/必填等必须与节点 parseParams 读取的字段一致，
 * 否则编辑器预填与执行行为不符。仅供编辑器可视化配置使用，不影响运行时。
 */
export interface ParamField {
  /** 参数键：与节点 execute 读取的 params[key] 一致 */
  readonly key: string;
  /** 中文展示名 */
  readonly label: string;
  /** 控件类型 */
  readonly type: ParamFieldType;
  /** 缺省值：与运行时 parseParams 缺省值一致（仅可选字段携带） */
  readonly default?: unknown;
  /** 是否必填：true 时编辑器强制用户提供，不携带 default */
  readonly required?: boolean;
  /** 中文说明 */
  readonly description?: string;
  /** 输入占位提示 */
  readonly placeholder?: string;
  /** select 类型可选项 */
  readonly options?: readonly { readonly label: string; readonly value: string }[];
}

/**
 * 节点定义：引擎按 type 查注册表获得执行逻辑。
 * execute 返回输出端口值映射 { outputPortId: value }。
 */
export interface INodeDefinition {
  /** 节点类型标识 */
  type: string;
  /** 展示名 */
  name: string;
  /** 参数面板 schema（v0.4.0 T1）：编辑器可视化配置用；缺省=无用户参数。 */
  paramsSchema?: readonly ParamField[];
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
  /** MCP 进程池（v0.4.2 D2）：AI 节点经 activeGroups.mcps 发现并注入 MCP 工具；子图容器透传给子引擎。 */
  readonly mcpPool?: McpServerPool;
  /** 功能组根目录（v0.3.1 T5 子图透传）：子图容器转发给子引擎 options，嵌套子图按同样配置运行时加载。 */
  readonly groupsRootDir?: string;
  /** 功能组缓存容量（v0.3.1 T5 子图透传）：子图容器转发给子引擎 options，缺省子引擎默认 32。 */
  readonly groupCacheMaxSize?: number;
  /** 功能组核心版本兼容（v0.3.2 T8 子图透传）：子图容器转发给子引擎 options；默认不兼容抛错，true 仅 warn。 */
  readonly allowIncompatibleGroups?: boolean;
  /** 子工作流模板根目录（v0.3.3 T2 子图透传）：subworkflow 节点 params.template 引用加载模板库用；子图容器转发给子引擎 options。 */
  readonly templatesRootDir?: string;
  /** 本次运行已批准人工审核的节点 id 集合（v0.4.2 验收 2）：command 节点 reviewRequired 放行依据；
   *  缺省 undefined（未注入即未批准）；v0.4.3 起子图容器经 sharedReviewApprovals 共享同一集合。 */
  readonly reviewApprovals?: ReadonlySet<string>;
  /** 人工审核回调（v0.4.3 子图透传）：subworkflow 节点转发给子引擎 options；子图内 command reviewRequired 节点按此询问，缺省 reject。 */
  readonly onReviewRequired?: (info: { readonly nodeId: string; readonly description: string }) => Promise<"approve" | "reject">;
  /** 已批准审核节点共享集合（v0.4.3 子图透传）：父引擎注入可变引用，子引擎 approve 写回同一集合（父级重跑不再询问）。 */
  readonly sharedReviewApprovals?: Set<string>;
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
