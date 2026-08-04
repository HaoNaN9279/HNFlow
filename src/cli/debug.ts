// debug 子命令：调试视图（v0.2.4）。runs 列表（listByStatus 过滤）、context 变量快照（含 branch 分支）、
// trace AI 事件时间线（data.kind: tool_call/tool_result/llm_message）、logs 节点日志（node:start/end/error/waiting）。
// 数据源：RunState JSON 默认（run_states.json）+ execution_logs SQLite（dbPath 默认 hnflow.db，项目 db 路径惯例）。
import { RunStateStore } from "../runstate/RunStateStore.js";
import type { RunState } from "../runstate/types.js";
import { ExecutionLogStore } from "../logs/ExecutionLogStore.js";
import type { ExecutionLogEntry } from "../logs/types.js";
import { describeError, fail, jsonSummary, printTable } from "./util.js";

const DEFAULT_STORE = "./run_states.json";
const DEFAULT_DB = "./hnflow.db";
const VALID_STATUSES = ["running", "waiting", "paused", "success", "failed"] as const;
const VALID_LEVELS = ["info", "warn", "error"] as const;
type DebugStatus = (typeof VALID_STATUSES)[number];
type DebugLevel = (typeof VALID_LEVELS)[number];
type AiEventKind = "tool_call" | "tool_result" | "llm_message";

/** bun run src/cli/index.ts debug <子命令> ... */
export async function cmdDebug(args: readonly string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "runs":
      return debugRuns(args.slice(1));
    case "context":
      return debugContext(args.slice(1));
    case "trace":
      return debugTrace(args.slice(1));
    case "logs":
      return debugLogs(args.slice(1));
    default:
      return fail(
        sub === undefined ? "缺少 debug 子命令" : `未知 debug 子命令: ${sub}`,
        "debug runs|context|trace|logs",
      );
  }
}

/** 手工解析 --key value 选项：返回选项字典与位置参数列表。 */
function parseOptions(
  args: readonly string[],
  optionNames: readonly string[],
): { options: Readonly<Record<string, string>>; positional: readonly string[] } {
  const options: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // noUncheckedIndexedAccess 越界防御
    const name = arg.startsWith("--") ? arg.slice(2) : undefined;
    if (name !== undefined && optionNames.includes(name)) {
      const value = args[i + 1];
      if (value !== undefined) {
        options[name] = value;
        i++;
        continue;
      }
    }
    positional.push(arg);
  }
  return { options, positional };
}

/** debug runs [storePath] [--status ...]：列表 run；无记录提示空。 */
async function debugRuns(args: readonly string[]): Promise<number> {
  const { options, positional } = parseOptions(args, ["status"]);
  const storePath = positional[0] ?? DEFAULT_STORE;
  const usage = "debug runs [storePath] [--status running|waiting|paused|success|failed]";
  try {
    const store = new RunStateStore({ filePath: storePath });
    const rawStatus = options["status"];
    if (rawStatus !== undefined && !isDebugStatus(rawStatus)) {
      return fail(`非法状态: ${rawStatus}`, usage);
    }
    const runs = rawStatus === undefined ? await store.list() : await store.listByStatus(rawStatus);
    if (runs.length === 0) return (console.log("无运行记录"), 0);
    printTable(
      ["runId", "workflowId", "status", "updatedAt"],
      runs.map((run) => [run.runId, run.workflowId, run.status, new Date(run.updatedAt).toLocaleString()]),
    );
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** debug context <runId> [nodeId] [--store <storePath>]：渲染变量快照。 */
async function debugContext(args: readonly string[]): Promise<number> {
  const { options, positional } = parseOptions(args, ["store"]);
  const runId = positional[0];
  if (runId === undefined) {
    return fail("缺少 runId", "debug context <runId> [nodeId] [--store <storePath>]");
  }
  const usage = "debug context <runId> [nodeId] [--store <storePath>]";
  try {
    const store = new RunStateStore({ filePath: options["store"] ?? DEFAULT_STORE });
    const run = await store.getById(runId);
    if (run === undefined) return fail(`未找到运行记录: ${runId}`, usage);
    printContext(run, positional[1]);
    return 0;
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** debug trace <runId> <nodeId> [dbPath]：AI 事件时间线（data.kind 过滤）。 */
async function debugTrace(args: readonly string[]): Promise<number> {
  const runId = args[0];
  const nodeId = args[1];
  if (runId === undefined || nodeId === undefined) {
    return fail("缺少 runId 或 nodeId", "debug trace <runId> <nodeId> [dbPath]");
  }
  const usage = "debug trace <runId> <nodeId> [dbPath]";
  try {
    const store = new ExecutionLogStore(args[2] ?? DEFAULT_DB);
    try {
      const events = (await store.list({ runId, nodeId }))
        .map(toTraceRow)
        .filter((row): row is TraceRow => row !== undefined);
      if (events.length === 0) return (console.log("无 AI 事件"), 0);
      console.log(`runId: ${runId}`);
      console.log(`nodeId: ${nodeId}`);
      console.log(`AI 事件时间线 (${events.length}):`);
      printTable(
        ["#", "kind", "detail"],
        events.map((row, index) => [String(index + 1), row.kind, row.detail]),
      );
      return 0;
    } finally {
      await store.close();
    }
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** debug logs <runId> [nodeId] [--level ...] [dbPath]：节点生命周期日志（node: 前缀，按 createdAt 升序）。 */
async function debugLogs(args: readonly string[]): Promise<number> {
  const runId = args[0];
  if (runId === undefined) {
    return fail("缺少 runId", "debug logs <runId> [nodeId] [--level info|warn|error] [dbPath]");
  }
  const { options, positional } = parseOptions(args.slice(1), ["level"]);
  const usage = "debug logs <runId> [nodeId] [--level info|warn|error] [dbPath]";
  const rawLevel = options["level"];
  if (rawLevel !== undefined && !isDebugLevel(rawLevel)) {
    return fail(`非法级别: ${rawLevel}`, usage);
  }
  const level = rawLevel === undefined ? undefined : rawLevel;
  try {
    const store = new ExecutionLogStore(positional[1] ?? DEFAULT_DB);
    try {
      const rows = await store.list({
        runId,
        ...(positional[0] === undefined ? {} : { nodeId: positional[0] }),
        ...(level === undefined ? {} : { level }),
      });
      const nodeLogs = rows.filter((row) => row.message.startsWith("node:"));
      if (nodeLogs.length === 0) return (console.log("无节点日志"), 0);
      console.log(`runId: ${runId}`);
      console.log(`节点日志 (${nodeLogs.length}):`);
      printTable(
        ["level", "message", "data"],
        nodeLogs.map((entry) => [entry.level, entry.message, entry.data === undefined ? "" : jsonSummary(entry.data)]),
      );
      return 0;
    } finally {
      await store.close();
    }
  } catch (error) {
    return fail(describeError(error), usage);
  }
}

/** 渲染变量快照：默认 global + workflow；nodeId 时追加 node:<id> 作用域（含 branch:* 分支快照）。 */
function printContext(run: RunState, nodeId?: string): void {
  console.log(`runId: ${run.runId}`);
  console.log(`status: ${run.status}`);
  if (run.pendingNodeId !== undefined) console.log(`pendingNodeId: ${run.pendingNodeId}`);
  if (run.error !== undefined) console.log(`error: ${run.error}`);
  console.log("上下文快照:");
  printScope("global", run.contextSnapshot.global);
  printScope("workflow", run.contextSnapshot.workflow);
  if (nodeId !== undefined) printScope(`node:${nodeId}`, run.contextSnapshot.node[`node:${nodeId}`] ?? {});
}

/** 打印单个作用域的键值对（空作用域提示空）。 */
function printScope(name: string, scope: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(scope);
  if (keys.length === 0) return console.log(`  ${name}: （空）`);
  console.log(`  ${name}:`);
  for (const key of keys) {
    console.log(`    ${key}: ${jsonSummary(scope[key])}`);
  }
}

interface TraceRow {
  readonly kind: AiEventKind;
  readonly detail: string;
}

/** 日志条目 → AI 事件行；非 AI 事件（data.kind 缺失）返回 undefined。 */
function toTraceRow(entry: ExecutionLogEntry): TraceRow | undefined {
  const kind = aiEventKind(entry.data);
  if (kind === undefined) return undefined;
  const toolName = asString(entry.data, "toolName", "");
  switch (kind) {
    case "tool_call":
      return { kind, detail: `${toolName} args=${jsonSummary(asValue(entry.data, "args"))}` };
    case "tool_result":
      return { kind, detail: `${toolName} result=${jsonSummary(asValue(entry.data, "result"))}` };
    case "llm_message":
      return { kind, detail: asString(entry.data, "message", "") };
  }
}

const isDebugStatus = (value: string): value is DebugStatus =>
  (VALID_STATUSES as readonly string[]).includes(value);

const isDebugLevel = (value: string): value is DebugLevel =>
  (VALID_LEVELS as readonly string[]).includes(value);

/** 从日志 data 提取 AI 事件 kind；未知结构返回 undefined。 */
function aiEventKind(data: unknown): AiEventKind | undefined {
  const kind = asValue(data, "kind");
  return kind === "tool_call" || kind === "tool_result" || kind === "llm_message" ? kind : undefined;
}

/** 从 record 结构安全取值（data 来自 SQLite JSON 反序列化，形状未知）。 */
function asValue(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null || !(key in data)) return undefined;
  return (data as Record<string, unknown>)[key];
}

/** 从 record 结构取字符串字段；非字符串回退 fallback。 */
function asString(data: unknown, key: string, fallback: string): string {
  const value = asValue(data, key);
  return typeof value === "string" ? value : fallback;
}
