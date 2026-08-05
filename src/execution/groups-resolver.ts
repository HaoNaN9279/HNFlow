// 功能组运行时解析器（v0.3.1 T5）：把节点声明的 capabilityGroups 在 execute 前加载并合并为 activeGroups。
// GroupRuntime 实例跨节点复用（LRU 缓存 AC1：同一功能组多节点只读一次盘）；
// 声明非法抛 GroupResolveError（含节点路径）；加载失败抛 GroupLoadError（含 guid@version+原因）。
// 独立文件：控制 Engine.ts 行数（既有上限 440），Engine 只持有实例并调用 resolve。
import type { Node } from "../model/types.js";
import { mergeGroups, type MergedGroups } from "../groups/merge.js";
import { GroupRuntime } from "../groups/runtime.js";
import { parseCapabilityGroups } from "../groups/resolve.js";

/** 功能组解析器选项（ExecutionEngineOptions 子集：仅运行时加载相关字段）。 */
export interface GroupsResolverOptions {
  readonly groupsRootDir?: string;
  readonly groupCacheMaxSize?: number;
}

/** 节点 capabilityGroups 声明 → 运行时加载并合并 → activeGroups；未配置 rootDir / 节点无声明 → undefined。 */
export class GroupsResolver {
  private readonly runtime: GroupRuntime | undefined;

  constructor(options: GroupsResolverOptions) {
    this.runtime =
      options.groupsRootDir === undefined
        ? undefined
        : new GroupRuntime({
            rootDir: options.groupsRootDir,
            ...(options.groupCacheMaxSize === undefined ? {} : { cacheMaxSize: options.groupCacheMaxSize }),
          });
  }

  /**
   * 加载并合并节点声明的功能组；未配置 groupsRootDir 或节点无 capabilityGroups 声明 → undefined（不加载不抛错）。
   * 声明非法抛 GroupResolveError；加载失败抛 GroupLoadError（含 guid@version 与原因）。
   */
  async resolve(node: Node): Promise<MergedGroups | undefined> {
    if (this.runtime === undefined) return undefined;
    const raw = node.params["capabilityGroups"];
    if (raw === undefined) return undefined;
    const declarations = parseCapabilityGroups(raw, `${node.id} (${node.name})`);
    if (declarations.length === 0) return undefined;
    const contents = await this.runtime.loadMany(declarations);
    return mergeGroups(contents);
  }

  /** 实际读盘次数（测试断言跨节点缓存复用：同功能组多节点只读一次盘）。 */
  get diskReadCount(): number {
    return this.runtime?.diskReadCount ?? 0;
  }
}
