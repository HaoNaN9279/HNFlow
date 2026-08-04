// SqliteCheckpointSaver 测试：5 抽象方法语义、createAgent 集成冒烟、共享连接、外层事务回滚。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Checkpoint, CheckpointListOptions, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { SqliteCheckpointSaver } from "../src/ai/checkpoint-saver.js";
import { SqliteHumanTaskStore } from "../src/db/stores.js";
import { openDatabase } from "../src/db/index.js";
import { FakeLLM } from "../src/ai/fake-llm.js";

const TEMP_BASE = "C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode\\checkpoint-saver-test";

let fileCounter = 0;
function nextDbPath(prefix: string): string {
  return join(TEMP_BASE, `${prefix}-${Date.now()}-${fileCounter++}.db`);
}

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  // Windows 上 sqlite 句柄释放有瞬态延迟，重试删除避免 EBUSY。
  await rmRetry(TEMP_BASE);
}, 30000);

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试。Windows sqlite 句柄释放可达数秒。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows bun:sqlite 句柄释放依赖 GC，强制回收以解锁文件
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 构造 v4 格式 Checkpoint；缺省字段自动填充。 */
function makeCheckpoint(id: string, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    v: overrides.v ?? 4,
    id: overrides.id ?? id,
    ts: overrides.ts ?? new Date().toISOString(),
    channel_values: overrides.channel_values ?? {},
    channel_versions: overrides.channel_versions ?? {},
    versions_seen: overrides.versions_seen ?? {},
  };
}

/** 构造 CheckpointMetadata。 */
function makeMetadata(overrides: Partial<CheckpointMetadata> = {}): CheckpointMetadata {
  return {
    source: overrides.source ?? "input",
    step: overrides.step ?? -1,
    parents: overrides.parents ?? {},
  };
}

/** 收集 list 全部 tuple 的 checkpoint_id。 */
async function collectIds(saver: SqliteCheckpointSaver, threadId: string, options?: CheckpointListOptions): Promise<string[]> {
  const ids: string[] = [];
  for await (const tuple of saver.list({ configurable: { thread_id: threadId } }, options)) {
    const id = tuple.config.configurable?.checkpoint_id;
    if (typeof id === "string") {
      ids.push(id);
    }
  }
  return ids;
}

describe("SqliteCheckpointSaver", () => {
  test("put → getTuple（指定 id）往返：checkpoint.id/ts/channel_values 一致", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("roundtrip"));
    try {
      const cp = makeCheckpoint("cp-rt", { channel_values: { count: 7, nested: { a: [1, 2] } } });
      const config = await saver.put(
        { configurable: { thread_id: "t-rt" } },
        cp,
        makeMetadata({ step: 1 }),
        {},
      );
      const tuple = await saver.getTuple({ configurable: { thread_id: "t-rt", checkpoint_id: "cp-rt" } });
      expect(tuple).toBeDefined();
      expect(tuple?.checkpoint.id).toBe("cp-rt");
      expect(tuple?.checkpoint.ts).toBe(cp.ts);
      expect(tuple?.checkpoint.v).toBe(4);
      expect(tuple?.checkpoint.channel_values).toEqual({ count: 7, nested: { a: [1, 2] } });
      expect(tuple?.metadata?.step).toBe(1);
      expect(config.configurable?.checkpoint_id).toBe("cp-rt");
    } finally {
      await saver.close();
    }
  });

  test("getTuple 不指定 id 取最新：同一 thread 两次 put → 取第二次", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("latest"));
    try {
      await saver.put(
        { configurable: { thread_id: "t-latest" } },
        makeCheckpoint("cp-a", { channel_values: { v: "a" } }),
        makeMetadata(),
        {},
      );
      await saver.put(
        { configurable: { thread_id: "t-latest" } },
        makeCheckpoint("cp-b", { channel_values: { v: "b" } }),
        makeMetadata(),
        {},
      );
      const tuple = await saver.getTuple({ configurable: { thread_id: "t-latest" } });
      expect(tuple?.checkpoint.id).toBe("cp-b");
      expect(tuple?.checkpoint.channel_values).toEqual({ v: "b" });
      // 取最新时返回 config 携带 checkpoint_id。
      expect(tuple?.config.configurable?.checkpoint_id).toBe("cp-b");
    } finally {
      await saver.close();
    }
  });

  test("put 返回 config 含新 checkpoint_id，可被再次 getTuple 使用", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("returned-config"));
    try {
      const config = await saver.put(
        { configurable: { thread_id: "t-ret" } },
        makeCheckpoint("cp-1"),
        makeMetadata(),
        {},
      );
      expect(config.configurable?.checkpoint_id).toBe("cp-1");
      const tuple = await saver.getTuple(config);
      expect(tuple?.checkpoint.id).toBe("cp-1");
    } finally {
      await saver.close();
    }
  });

  test("parent 链：第二次 put 带 parent_checkpoint_id → getTuple 的 parentConfig 正确", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("parent"));
    try {
      const config1 = await saver.put(
        { configurable: { thread_id: "t-parent" } },
        makeCheckpoint("cp-p1"),
        makeMetadata({ source: "input" }),
        {},
      );
      await saver.put(config1, makeCheckpoint("cp-p2", { channel_values: { v: 2 } }), makeMetadata({ source: "loop", step: 0 }), {});
      const tuple = await saver.getTuple({ configurable: { thread_id: "t-parent" } });
      expect(tuple?.checkpoint.id).toBe("cp-p2");
      expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe("cp-p1");
      expect(tuple?.parentConfig?.configurable?.thread_id).toBe("t-parent");
      // 父 checkpoint 也可单独读取。
      const parentTuple = await saver.getTuple({ configurable: { thread_id: "t-parent", checkpoint_id: "cp-p1" } });
      expect(parentTuple?.checkpoint.id).toBe("cp-p1");
    } finally {
      await saver.close();
    }
  });

  test("putWrites → getTuple 的 pendingWrites 恢复（task_id, idx 序）", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("writes"));
    try {
      const config = await saver.put(
        { configurable: { thread_id: "t-w" } },
        makeCheckpoint("cp-w"),
        makeMetadata(),
        {},
      );
      await saver.putWrites(config, [["channel-a", { x: 1 }], ["channel-b", "hello"]], "task-1");
      const tuple = await saver.getTuple({ configurable: { thread_id: "t-w", checkpoint_id: "cp-w" } });
      expect(tuple?.pendingWrites).toEqual([
        ["task-1", "channel-a", { x: 1 }],
        ["task-1", "channel-b", "hello"],
      ]);
    } finally {
      await saver.close();
    }
  });

  test("putWrites 特殊 channel 走 WRITES_IDX_MAP 负索引（排在普通写前）", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("writes-map"));
    try {
      const config = await saver.put(
        { configurable: { thread_id: "t-wm" } },
        makeCheckpoint("cp-wm"),
        makeMetadata(),
        {},
      );
      await saver.putWrites(config, [["__error__", "boom"], ["channel-a", 1]], "task-9");
      const tuple = await saver.getTuple({ configurable: { thread_id: "t-wm", checkpoint_id: "cp-wm" } });
      // __error__ idx = -1 < 0 → 排前。
      expect(tuple?.pendingWrites).toEqual([
        ["task-9", "__error__", "boom"],
        ["task-9", "channel-a", 1],
      ]);
    } finally {
      await saver.close();
    }
  });

  test("list：多条按 checkpoint_id 倒序；limit 生效；before 生效", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("list"));
    try {
      const configurable = { thread_id: "t-list" };
      await saver.put({ configurable }, makeCheckpoint("cp-1"), makeMetadata({ source: "input" }), {});
      await saver.put({ configurable }, makeCheckpoint("cp-2"), makeMetadata({ source: "loop", step: 0 }), {});
      await saver.put({ configurable }, makeCheckpoint("cp-3"), makeMetadata({ source: "loop", step: 1 }), {});
      expect(await collectIds(saver, "t-list")).toEqual(["cp-3", "cp-2", "cp-1"]);
      expect(await collectIds(saver, "t-list", { limit: 2 })).toEqual(["cp-3", "cp-2"]);
      expect(
        await collectIds(saver, "t-list", { before: { configurable: { thread_id: "t-list", checkpoint_id: "cp-3" } } }),
      ).toEqual(["cp-2", "cp-1"]);
    } finally {
      await saver.close();
    }
  });

  test("deleteThread：删除后 getTuple undefined、list 空，其他线程不受影响", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("delete"));
    try {
      const configurable = { thread_id: "t-del" };
      const config = await saver.put({ configurable }, makeCheckpoint("cp-d1"), makeMetadata(), {});
      await saver.putWrites(config, [["ch", 1]], "task-d");
      await saver.deleteThread("t-del");
      expect(await saver.getTuple({ configurable })).toBeUndefined();
      expect(await collectIds(saver, "t-del")).toEqual([]);
      // 其他线程不受影响。
      await saver.put({ configurable: { thread_id: "t-other" } }, makeCheckpoint("cp-o"), makeMetadata(), {});
      expect((await saver.getTuple({ configurable: { thread_id: "t-other" } }))?.checkpoint.id).toBe("cp-o");
    } finally {
      await saver.close();
    }
  });

  test("put 缺 thread_id 抛中文错误", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("no-thread"));
    try {
      await expect(
        saver.put({ configurable: {} }, makeCheckpoint("cp-x"), makeMetadata(), {}),
      ).rejects.toThrow("thread_id");
    } finally {
      await saver.close();
    }
  });
});

describe("createAgent 集成冒烟", () => {
  test("同 thread 两次 invoke 状态保持（新 agent 实例复用 checkpointer）", async () => {
    const saver = new SqliteCheckpointSaver(nextDbPath("agent"));
    try {
      const myTool = tool(() => "工具输出", { name: "my_tool", description: "测试工具", schema: z.object({}) });
      const llm1 = new FakeLLM({
        script: [
          { kind: "tool_call", toolCall: { name: "my_tool", args: {} } },
          { kind: "text", text: "第一轮完成" },
        ],
      });
      const agent1 = createAgent({ model: llm1, tools: [myTool], checkpointer: saver });
      const result1 = await agent1.invoke(
        { messages: [{ role: "user", content: "第一问" }] },
        { configurable: { thread_id: "thread-agent" } },
      );

      // 新 agent（新 llm）同 thread 继续：checkpoint 恢复历史消息。
      const llm2 = new FakeLLM({ script: [{ kind: "text", text: "第二轮完成" }] });
      const agent2 = createAgent({ model: llm2, tools: [myTool], checkpointer: saver });
      const result2 = await agent2.invoke(
        { messages: [{ role: "user", content: "第二问" }] },
        { configurable: { thread_id: "thread-agent" } },
      );

      expect(result2.messages.length).toBeGreaterThan(result1.messages.length);
      const roundTexts = result2.messages.filter(
        (m) => typeof m.content === "string" && (m.content === "第一轮完成" || m.content === "第二轮完成"),
      );
      expect(roundTexts).toHaveLength(2);
      // llm2 确实收到恢复的历史（脚本只推进 1 步即完成）。
      expect(llm2.stepIndex).toBe(1);
    } finally {
      await saver.close();
    }
  });
});

describe("共享连接与外层事务", () => {
  test("与 SqliteHumanTaskStore 同传 sharedDb：各自写读互见（同库同连接）", async () => {
    const dbPath = nextDbPath("shared");
    const sharedDb = await openDatabase(dbPath);
    sharedDb.ensureSchema();
    const saver = new SqliteCheckpointSaver(dbPath, sharedDb);
    const taskStore = new SqliteHumanTaskStore(dbPath, sharedDb);
    try {
      await saver.put({ configurable: { thread_id: "t-shared" } }, makeCheckpoint("cp-shared"), makeMetadata(), {});
      const task = await taskStore.create({
        workflowId: "wf-shared",
        nodeId: "n1",
        nodeName: "审批",
        title: "共享审批",
      });
      // 同连接直查两表：checkpoint 与 human_task 同库可见。
      expect(sharedDb.db.prepare("SELECT 1 FROM checkpoints WHERE thread_id = ?").get("t-shared")).toBeDefined();
      expect(sharedDb.db.prepare("SELECT 1 FROM human_tasks WHERE id = ?").get(task.id)).toBeDefined();
      // 各自读回。
      expect((await saver.getTuple({ configurable: { thread_id: "t-shared" } }))?.checkpoint.id).toBe("cp-shared");
      expect((await taskStore.getById(task.id))?.title).toBe("共享审批");
    } finally {
      await taskStore.close(); // 共享连接不关闭
      await saver.close(); // 共享连接不关闭
      sharedDb.close(); // 共享方负责关闭
    }
  });

  test("外层事务：begin → put → rollback → 读回 undefined（可参与外层回滚）", async () => {
    const dbPath = nextDbPath("tx");
    const sharedDb = await openDatabase(dbPath);
    sharedDb.ensureSchema();
    const saver = new SqliteCheckpointSaver(dbPath, sharedDb);
    try {
      const tx = sharedDb.db.begin();
      await saver.put({ configurable: { thread_id: "t-tx" } }, makeCheckpoint("cp-tx"), makeMetadata(), {});
      // 事务内可见。
      expect((await saver.getTuple({ configurable: { thread_id: "t-tx" } }))?.checkpoint.id).toBe("cp-tx");
      tx.rollback();
      // 回滚后消失。
      expect(await saver.getTuple({ configurable: { thread_id: "t-tx" } })).toBeUndefined();
    } finally {
      await saver.close();
      sharedDb.close();
    }
  });
});
