// 运行时能力组加载器（v0.3.1 T4）：按节点声明的 guid@version 懒加载功能组内容，
// LRU 缓存复用（同一功能组多节点不重复读盘），加载失败统一抛 GroupLoadError（含 guid@version 与原因）。
import { GroupContentLoadError, loadGroupContent, type LoadedGroupContent } from "./content-loader.js";
import { findGroupByGuid, loadVersion } from "./load.js";
import { LRUCache } from "./lru-cache.js";

/** 运行时加载器选项。 */
export interface GroupRuntimeOptions {
  readonly rootDir: string;
  readonly cacheMaxSize?: number; // LRU 容量，默认 32
}

/** 加载失败：guid@version 加载/校验失败。 */
export class GroupLoadError extends Error {
  readonly name = "GroupLoadError";
  readonly guid: string;
  readonly version: string;
  constructor(guid: string, version: string, message: string) {
    super(`${guid}@${version} 加载失败：${message}`);
    this.guid = guid;
    this.version = version;
  }
}

/** 运行时加载器：按 guid@version 懒加载 + LRU 缓存复用。 */
export class GroupRuntime {
  private readonly rootDir: string;
  private readonly cache: LRUCache<string, LoadedGroupContent>;
  private diskReadCountValue = 0;

  constructor(options: GroupRuntimeOptions) {
    this.rootDir = options.rootDir;
    this.cache = new LRUCache(options.cacheMaxSize ?? 32);
  }

  /** 加载单个功能组版本；命中缓存直接返回；失败抛 GroupLoadError（含 guid@version 与原因）。 */
  async load(guid: string, version: string): Promise<LoadedGroupContent> {
    const cacheKey = `${guid}@${version}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached; // 缓存命中：不读盘
    }
    const group = await findGroupByGuid(this.rootDir, guid);
    if (group === undefined) {
      throw new GroupLoadError(guid, version, "功能组不存在");
    }
    if (loadVersion(group, version) === undefined) {
      throw new GroupLoadError(guid, version, "版本不存在");
    }
    let content: LoadedGroupContent;
    try {
      content = await loadGroupContent(this.rootDir, group, version);
    } catch (error) {
      if (error instanceof GroupContentLoadError) {
        throw new GroupLoadError(guid, version, error.message);
      }
      throw error; // 非内容加载错误（如 rootDir 不可访问）原样抛
    }
    this.cache.set(cacheKey, content);
    this.diskReadCountValue += 1;
    return content;
  }

  /**
   * 批量加载（顺序保留）：逐个 load，任一失败即抛。
   * 本次新加载成功的项在失败时回滚出缓存（不缓存半成品），再 load 会重新读盘；此前已缓存的项不受影响。
   */
  async loadMany(
    declarations: readonly { readonly guid: string; readonly version: string }[],
  ): Promise<LoadedGroupContent[]> {
    const newlyLoadedKeys: string[] = [];
    const loaded: LoadedGroupContent[] = [];
    try {
      for (const declaration of declarations) {
        const cacheKey = `${declaration.guid}@${declaration.version}`;
        const wasCached = this.cache.peek(cacheKey) !== undefined;
        const content = await this.load(declaration.guid, declaration.version);
        loaded.push(content);
        if (!wasCached) {
          newlyLoadedKeys.push(cacheKey);
        }
      }
      return loaded;
    } catch (error) {
      // 批量失败：本次新加载的项不缓存半成品，删除后整体重抛。
      for (const cacheKey of newlyLoadedKeys) {
        this.cache.delete(cacheKey);
      }
      throw error;
    }
  }

  /** 当前缓存元素数（测试断言缓存复用）。 */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 实际读盘次数计数（测试断言懒加载/缓存命中：同组第二次 load 不增加计数）。 */
  get diskReadCount(): number {
    return this.diskReadCountValue;
  }
}
