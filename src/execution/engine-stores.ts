// 引擎存储管理（v0.3.1 T5 重构）：sqlite 共享句柄判定 + HumanTaskStore/RunStateStore 惰性创建。
// 拆自 Engine.ts 控制行数（既有上限 440）；getter 依赖引擎配置与内部缓存字段，参数化构造持有。
// 惰性语义与原 Engine getter 一致：aiCheckpoint.sharedDb 存在且未显式提供 store 时用 sqlite 事务共享 store。
import { SqliteHumanTaskStore, SqliteRunStateStore, type SqliteDatabase } from "../db/index.js";
import type { HumanTaskStoreLike, RunStateStoreLike } from "../db/stores/types.js";
import { HumanTaskStore } from "../human/HumanTaskStore.js";
import { RunStateStore } from "../runstate/RunStateStore.js";

/** 引擎存储构造选项（ExecutionEngineOptions 存储相关字段子集）。 */
export interface EngineStoresOptions {
  readonly aiCheckpoint?: { readonly dbPath: string; readonly sharedDb?: SqliteDatabase };
  readonly humanTaskStore?: HumanTaskStoreLike;
  readonly runStateStore?: RunStateStoreLike;
}

/** 引擎存储持有者：惰性创建 HumanTaskStore/RunStateStore（sqlite 共享 db 时同事务）。 */
export class EngineStores {
  private humanTaskStoreValue: HumanTaskStoreLike | undefined;
  private runStateStoreValue: RunStateStoreLike | undefined;

  constructor(private readonly options: EngineStoresOptions) {}

  private sqliteAi(): { readonly dbPath: string; readonly sharedDb: SqliteDatabase } | undefined {
    const ai = this.options.aiCheckpoint;
    if (ai !== undefined && ai.sharedDb !== undefined) return { dbPath: ai.dbPath, sharedDb: ai.sharedDb };
    return undefined;
  }

  get humanTaskStore(): HumanTaskStoreLike {
    if (this.humanTaskStoreValue === undefined) {
      const ai = this.sqliteAi();
      this.humanTaskStoreValue = ai !== undefined && this.options.humanTaskStore === undefined
        ? new SqliteHumanTaskStore(ai.dbPath, ai.sharedDb)
        : (this.options.humanTaskStore ?? new HumanTaskStore());
    }
    return this.humanTaskStoreValue;
  }

  get runStateStore(): RunStateStoreLike {
    if (this.runStateStoreValue === undefined) {
      const ai = this.sqliteAi();
      this.runStateStoreValue = ai !== undefined && this.options.runStateStore === undefined
        ? new SqliteRunStateStore(ai.dbPath, ai.sharedDb)
        : (this.options.runStateStore ?? new RunStateStore());
    }
    return this.runStateStoreValue;
  }
}
