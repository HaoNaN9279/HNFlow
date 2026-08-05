// 泛型 LRU 缓存（v0.3.1 T3）：最近最少使用淘汰，供运行时加载器缓存复用。
// key 预期为 "guid@version" 字符串粒度，但 K 泛型无约束，支持任意键类型。
// 内部以 Map 的插入序充当访问序：读取 / 写入命中时 delete + set 刷新到末尾，
// 新增超容量时淘汰 Map 第一个 key（最久未用）。无外部依赖，严格 TS。

/** 泛型 LRU 缓存：最近最少使用淘汰，get/set 均刷新访问序。 */
export class LRUCache<K, V> {
  private readonly store = new Map<K, V>();
  readonly capacity: number;

  /** maxSize：容量上限，默认 32；构造时校验为正整数（<=0 抛 RangeError）。 */
  constructor(maxSize = 32) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(`LRUCache 容量必须是正整数，收到：${maxSize}`);
    }
    this.capacity = maxSize;
  }

  /** 当前元素数。 */
  get size(): number {
    return this.store.size;
  }

  /** 读取并刷新访问序；未命中返回 undefined。 */
  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      return undefined;
    }
    // 命中：先删除再重插，使该 key 移到 Map 末尾（最新访问序）
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  /** 写入：已存在则刷新访问序并更新值；新增超容量时淘汰最久未用。 */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      // 已存在：刷新访问序后更新值
      this.store.delete(key);
      this.store.set(key, value);
      return;
    }
    if (this.store.size >= this.capacity) {
      // 超容量：淘汰最久未用（Map 第一个 key）
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, value);
  }

  /** 只读不刷新访问序；未命中返回 undefined。 */
  peek(key: K): V | undefined {
    return this.store.get(key);
  }

  /** 是否存在（不刷新访问序）。 */
  has(key: K): boolean {
    return this.store.has(key);
  }

  /** 删除指定 key，返回是否删除成功。 */
  delete(key: K): boolean {
    return this.store.delete(key);
  }

  /** 清空。 */
  clear(): void {
    this.store.clear();
  }
}
