// 调试控制器（v0.2.4）：断点集合管理 + 命中判定 + 恢复消费 + 单步模式（step-over/step-into）与子图透传。
// 单步停点与子引擎深度（enterSubgraph/exitSubgraph）在本文件维护；容器判定回调由调用方注入（Engine 构造时透传）。
export interface DebugControllerOptions {
  /** 容器节点判定（subworkflow/tryCatch/finally/loop/parallel/ai 等含内嵌子图的类型）：step-into 放行容器进入子图用。 */
  readonly isContainer?: (nodeId: string) => boolean;
}

/** 单步模式：run=无意图（只停断点）；step-over=停拓扑序下一节点；step-into=进入子图停首节点。 */
export type DebugStepMode = "run" | "step-over" | "step-into";

export class DebugController {
  #breakpoints = new Set<string>();
  /** 恢复时消费一次的节点：resume 加入，shouldPause 检查命中则清除并返回 false。 */
  #skipOnceIds = new Set<string>();
  #mode: DebugStepMode = "run";
  /** step-over 停点：debugResume 恢复时按拓扑序 order[index+1] 设置。 */
  #stopAtNodeId: string | null = null;
  /** 子图透传深度：子引擎 runSubgraph/runBranch 构造时 enterSubgraph，结束 exitSubgraph。 */
  #subgraphDepth = 0;
  #isContainer: ((nodeId: string) => boolean) | undefined;

  constructor(options: DebugControllerOptions = {}) {
    this.#isContainer = options.isContainer;
  }

  /** 当前断点集合（只读视图）。 */
  get breakpoints(): ReadonlySet<string> {
    return this.#breakpoints;
  }

  /** 当前单步模式（子引擎透传 / 调试查询用）。 */
  get mode(): DebugStepMode {
    return this.#mode;
  }

  /** 覆盖式设置断点：ids 为节点 id 列表，空数组清空全部。 */
  setBreakpoints(ids: readonly string[]): void {
    this.#breakpoints = new Set(ids);
  }

  hasBreakpoint(nodeId: string): boolean {
    return this.#breakpoints.has(nodeId);
  }

  /** 断点 id 数组（RunState.debug 持久化用）。 */
  breakpointIds(): string[] {
    return [...this.#breakpoints];
  }

  /** 断点恢复消费：debugResume 时把当前节点加入 skipOnceIds。 */
  consumeResumeNode(nodeId: string): void {
    this.#skipOnceIds.add(nodeId);
  }

  /** 容器判定回调是否已注入（Engine 构造时缺省注入用）。 */
  hasContainerJudge(): boolean {
    return this.#isContainer !== undefined;
  }

  /** 容器判定注入：Engine 构造时按 options.isContainer 透传。 */
  setIsContainer(isContainer: (nodeId: string) => boolean): void {
    this.#isContainer = isContainer;
  }

  /** Step Over：恢复断点节点后停点在拓扑序下一节点（debugResume 按 order[index+1] 调用）。 */
  armStepOver(nextNodeId: string): void {
    this.#mode = "step-over";
    this.#stopAtNodeId = nextNodeId;
  }

  /** Step Into：进入子图内部首节点暂停（子引擎透传后由子引擎首节点命中，父级容器放行）。 */
  armStepInto(): void {
    this.#mode = "step-into";
    this.#stopAtNodeId = null;
  }

  /** Continue：清单步意图，只停断点。 */
  continueRun(): void {
    this.#mode = "run";
    this.#stopAtNodeId = null;
  }

  /** 进入子图执行：子引擎构造时透传调用（step-into 生效条件：深度>0）。 */
  enterSubgraph(): void {
    this.#subgraphDepth++;
  }

  /** 退出子图执行：子引擎 run 结束（含异常/paused）时调用。 */
  exitSubgraph(): void {
    this.#subgraphDepth--;
  }

  /**
   * 是否应暂停当前节点：断点命中优先 → step-over 命中 stopAtNodeId（仅当前层级）→ step-into 子图首节点；
   * 单步停点命中后清 mode（只停一次）。
   */
  shouldPause(nodeId: string): boolean {
    if (this.#skipOnceIds.has(nodeId)) {
      this.#skipOnceIds.delete(nodeId);
      return false;
    }
    if (this.#breakpoints.has(nodeId)) return true;
    if (this.#mode === "step-over") {
      // step-over 停点只在当前引擎层级生效：子引擎透传时深度>0，父级 stopAtNodeId 不匹配子图节点（id 冲突隔离）。
      if (this.#subgraphDepth === 0 && this.#stopAtNodeId === nodeId) {
        this.continueRun();
        return true;
      }
      return false;
    }
    if (this.#mode === "step-into") {
      // step-into：子引擎内部（深度>0）停首节点；父级容器放行进入子图；父级普通节点停（非函数调用时 step 语义）。
      if (this.#subgraphDepth > 0) {
        this.continueRun();
        return true;
      }
      if (this.#isContainer !== undefined && this.#isContainer(nodeId)) return false;
      this.continueRun();
      return true;
    }
    return false;
  }
}
