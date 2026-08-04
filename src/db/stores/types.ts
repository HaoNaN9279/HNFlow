// store 接口契约：JSON 与 SQLite 实现共同遵守，供 T7 Engine 类型收窄注入。
import type { HumanTask, HumanTaskSpec } from "../../human/types.js";
import type { RunState } from "../../runstate/types.js";

/** RunState 断点存储公共接口。 */
export interface RunStateStoreLike {
  create(run: RunState): Promise<void>;
  update(run: RunState): Promise<void>;
  getById(runId: string): Promise<RunState | undefined>;
  list(): Promise<RunState[]>;
  listByWorkflow(workflowId: string): Promise<RunState[]>;
}

/** HumanTask 存储公共接口（对齐 src/human/HumanTaskStore.ts 的公共方法，save/load 为 JSON 实现特有）。 */
export interface HumanTaskStoreLike {
  create(spec: HumanTaskSpec & { readonly workflowId: string; readonly nodeId: string; readonly nodeName: string }): Promise<HumanTask>;
  listAll(): Promise<HumanTask[]>;
  listPending(): Promise<HumanTask[]>;
  getById(id: string): Promise<HumanTask | undefined>;
  findPending(workflowId: string, nodeId: string): Promise<HumanTask | undefined>;
  /** 查找指定 workflow+node 最近创建的任务（任意状态；AI 多轮中断复用任务用）。 */
  findRecent(workflowId: string, nodeId: string): Promise<HumanTask | undefined>;
  complete(id: string, result?: unknown): Promise<HumanTask>;
  skip(id: string): Promise<HumanTask>;
  defer(id: string): Promise<HumanTask>;
  /**
   * 回退已完成任务到 pending：恢复失败（AC4）或多轮中断复用任务。
   * 仅 completed 可回退；result 保留（用户输入不丢）；meta 可选覆盖（多轮中断更新 checkpoint 上下文）。
   */
  reopen(id: string, meta?: Readonly<Record<string, unknown>>): Promise<HumanTask>;
}
