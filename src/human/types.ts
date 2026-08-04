// HumanTask 领域类型契约：人工确认任务的创建、状态流转与持久化结构。

export type HumanTaskStatus = "pending" | "completed" | "skipped" | "deferred";

/** 人工任务不可用时的兜底策略：manual=人工处理，skip=跳过，ai=AI 代做（占位），defer=延后补做 */
export type HumanTaskFallback = "manual" | "skip" | "ai" | "defer";

/** 创建人工任务的规格（不含运行时生成字段）。runId 为创建方执行实例标识（v0.2.5 T4：崩溃确认查重按 runId 精确匹配）。 */
export interface HumanTaskSpec {
  readonly title: string;
  readonly description?: string;
  readonly fallback?: HumanTaskFallback;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly runId?: string;
}

/** 持久化的人工任务记录。 */
export interface HumanTask {
  readonly id: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  /** 执行实例标识（v0.2.5 T4）：跨 run 同节点不串任务（findPending 精确查重用）；旧数据缺省 undefined。 */
  readonly runId?: string;
  readonly title: string;
  readonly description?: string;
  readonly status: HumanTaskStatus;
  readonly fallback: HumanTaskFallback;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly result?: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}
