// 节点执行状态机。
// 语义：
//   Idle --(start)--> Running --(success)--> Success
//                           --(failure)--> Failed
//                           --(skip)-----> Skipped
//                           --(wait)-----> WaitingForHuman --(resume)--> Running
//   WaitingForHuman 为人工审批/输入预留：v0.1.0 无节点进入该状态，
//   但类型与转移须支持；恢复（WaitingForHuman -> Running）同样预留。

export type NodeStatus =
  | "Idle"
  | "Running"
  | "Success"
  | "Failed"
  | "Skipped"
  | "WaitingForHuman";

/** 合法转移表：以 Record<NodeStatus, ...> 穷尽枚举全部来源状态，遗漏即编译错误。 */
const LEGAL_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  Idle: ["Running"],
  Running: ["Success", "Failed", "Skipped", "WaitingForHuman"],
  Success: [],
  Failed: [],
  Skipped: [],
  WaitingForHuman: ["Running"],
};

/** 非法状态转移：携带 from/to 便于定位。 */
export class NodeStateTransitionError extends Error {
  readonly from: NodeStatus;
  readonly to: NodeStatus;

  constructor(from: NodeStatus, to: NodeStatus) {
    super(`Illegal node status transition: ${from} -> ${to}`);
    this.name = "NodeStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** 节点状态机：单一来源维护 status，禁止一切未在转移表中声明的跳变。 */
export class NodeStateMachine {
  #status: NodeStatus;

  constructor(initialStatus: NodeStatus = "Idle") {
    this.#status = initialStatus;
  }

  get status(): NodeStatus {
    return this.#status;
  }

  transitionTo(next: NodeStatus): void {
    if (!LEGAL_TRANSITIONS[this.#status].includes(next)) {
      throw new NodeStateTransitionError(this.#status, next);
    }
    this.#status = next;
  }

  reset(): void {
    this.#status = "Idle";
  }
}
