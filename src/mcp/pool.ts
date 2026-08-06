/**
 * MCP Server 进程池。
 *
 * 语义：
 *  - 复用：同 name 的 Server 共享一个子进程，引用计数管理
 *  - 空闲释放：refCount 归 0 后 idleTimeoutMs 内无人再 acquire 则杀进程
 *  - 崩溃重启：子进程意外退出（dead）后，下次 acquire 自动重建新会话
 *  - 状态重置：stateful 会话崩溃后重建全新实例（进程重启 = 状态自然归零）
 *  - 并发去重：同 name 同时 acquire 只 spawn 一个进程（Promise 去重）
 */
import { McpSession } from "./session.js";
import type { McpServerConfig, McpToolInfo } from "./types.js";

/** 进程池选项。 */
export interface McpServerPoolOptions {
  /** 空闲释放超时（毫秒），缺省 5 分钟。 */
  idleTimeoutMs?: number;
}

/** 池内条目：会话 + 引用计数 + 空闲计时器 + 在途 spawn。 */
interface PoolEntry {
  config: McpServerConfig;
  session: McpSession;
  refCount: number;
  /** 空闲释放计时器（refCount 归 0 后启动，acquire 时取消）。 */
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** 在途 spawn Promise：同 name 并发 acquire 去重用。 */
  pending: Promise<McpSession> | undefined;
  /** 无状态会话崩溃后重建复用的工具列表缓存。 */
  cachedTools: McpToolInfo[];
}

/** MCP Server 进程池。 */
export class McpServerPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleTimeoutMs: number;
  private disposed = false;

  constructor(options?: McpServerPoolOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 5 * 60_000;
  }

  /** 获取会话：同 name 复用 live 会话；崩溃自动重建；并发去重只 spawn 一次。 */
  acquire(config: McpServerConfig): Promise<McpSession> {
    if (this.disposed) {
      throw new Error("MCP 进程池已 dispose");
    }
    const entry = this.entries.get(config.name);

    // 在途 spawn：并发去重，共享同一 Promise
    if (entry?.pending !== undefined) {
      return entry.pending;
    }

    // 复用 live 会话（引用计数 +1，取消空闲计时器）
    if (entry !== undefined && entry.session.isAlive()) {
      this.cancelIdle(entry);
      entry.refCount += 1;
      return Promise.resolve(entry.session);
    }

    // 无 live 会话（无条目或崩溃）：spawn 新进程
    return this.startSpawn(config, entry);
  }

  /** 释放引用：归 0 后启动空闲计时器，超时释放进程。 */
  release(name: string): void {
    const entry = this.entries.get(name);
    if (entry === undefined || entry.pending !== undefined || entry.refCount <= 0) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount === 0) {
      this.cancelIdle(entry);
      entry.idleTimer = setTimeout(() => {
        void this.expireIdle(name);
      }, this.idleTimeoutMs);
    }
  }

  /** 释放全部（测试清理）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer !== undefined) {
          clearTimeout(entry.idleTimer);
        }
        if (entry.pending !== undefined) {
          try {
            await entry.pending;
          } catch {
            // 在途 spawn 失败：会话已自行关闭，忽略
          }
        }
        await entry.session.close();
      }),
    );
  }

  /** 启动新会话进程；崩溃重建时复用旧条目资源并释放旧进程。 */
  private startSpawn(
    config: McpServerConfig,
    existing: PoolEntry | undefined,
  ): Promise<McpSession> {
    this.cancelIdle(existing);
    // 无状态崩溃重建：复用已发现的工具列表，跳过重复 listTools；
    // 状态型重建：全新实例（进程重启 = 状态自然归零）。
    const initTools =
      existing !== undefined && !existing.config.stateful ? existing.cachedTools : [];
    const session = new McpSession(config, initTools);
    if (existing !== undefined) {
      // 旧崩溃会话资源释放（幂等；进程已退出，仅清理 client 内部）
      void existing.session.close();
    }
    const pending = session.connect().then(
      () => {
        if (this.disposed) {
          return session;
        }
        const fresh: PoolEntry = {
          config,
          session,
          refCount: 1,
          idleTimer: undefined,
          pending: undefined,
          cachedTools: session.listTools(),
        };
        this.entries.set(config.name, fresh);
        return session;
      },
      (error: unknown) => {
        if (this.entries.get(config.name) === existing) {
          this.entries.delete(config.name);
        }
        void session.close();
        throw error;
      },
    );
    if (existing !== undefined) {
      // 占位：connect 完成前同 name acquire 走 pending 去重分支
      existing.session = session;
      existing.pending = pending;
    } else {
      this.entries.set(config.name, {
        config,
        session,
        refCount: 0,
        idleTimer: undefined,
        pending,
        cachedTools: [],
      });
    }
    return pending;
  }

  /** 空闲超时触发：释放进程并移除条目。 */
  private async expireIdle(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined || entry.pending !== undefined || entry.refCount > 0) {
      return;
    }
    await entry.session.close();
    if (this.entries.get(name) === entry) {
      this.entries.delete(name);
    }
  }

  /** 取消空闲计时器。 */
  private cancelIdle(entry: PoolEntry | undefined): void {
    if (entry !== undefined && entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }
}
