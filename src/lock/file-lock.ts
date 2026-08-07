// 跨进程文件锁：lockfile 原子创建（fs.open "wx"）+ 锁信息 JSON（pid/时间戳）+
// 心跳刷新 + 进程存活探测（process.kill(pid,0)）回收过期/死锁。
// 不支持环境（创建失败/心跳写失败/探测异常）→ 降级警告而非崩溃（验收 5）。
// 参照 src/storage/atomic.ts 的原子写惯例。
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeFileQuietly } from "../storage/atomic.js";

/** 降级警告文案：NAS/只读等不支持环境，跳过锁限制继续运行。 */
const DEGRADE_WARNING = "文件锁不可用（可能 NAS/只读环境），已降级：跳过锁限制";

/** 锁目录/名称配置。 */
export interface FileLockOptions {
  readonly dir: string; // 锁目录（自动 mkdir）
  readonly name: string; // 锁名（文件名，如 "instance" → instance.lock）
  readonly heartbeatMs?: number; // 心跳刷新间隔（默认 5000；0=禁用）
  readonly staleMs?: number; // 锁过期阈值（默认 10000）
  readonly disabled?: boolean; // 可配置关闭（验收 5）
}

/** 锁信息（与锁文件 JSON 内容对应）。 */
export interface LockOwner {
  readonly pid: number;
  readonly startedAt: number; // 创建/最近心跳时间，stale 探测依据
}

/** acquire 结果。 */
export interface AcquireResult {
  readonly ok: boolean;
  readonly warning?: string; // 降级警告（NAS/不支持环境）
  readonly owner?: LockOwner;
}

/** 跨进程文件锁。 */
export class FileLock {
  readonly #dir: string;
  readonly #name: string;
  readonly #lockPath: string;
  readonly #heartbeatMs: number;
  readonly #staleMs: number;
  readonly #disabled: boolean;
  #owner: LockOwner | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #heartbeatFailed = false;

  constructor(options: FileLockOptions) {
    this.#dir = options.dir;
    this.#name = options.name;
    this.#lockPath = join(options.dir, `${options.name}.lock`);
    this.#heartbeatMs = options.heartbeatMs ?? 5000;
    this.#staleMs = options.staleMs ?? 10000;
    this.#disabled = options.disabled ?? false;
  }

  /** 获取锁：原子创建 + 写锁信息 + 启动心跳。 */
  async acquire(): Promise<AcquireResult> {
    if (this.#disabled) return { ok: true }; // 用户主动关闭锁
    const pid = process.pid;
    const startedAt = Date.now();
    const content = `${JSON.stringify({ pid, startedAt })}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let created = false;
      try {
        await mkdir(this.#dir, { recursive: true });
        const file = await open(this.#lockPath, "wx"); // 原子创建：已存在即失败
        created = true;
        try {
          await file.writeFile(content, "utf8");
        } finally {
          await file.close();
        }
        this.#owner = { pid, startedAt };
        this.#startHeartbeat();
        return { ok: true, owner: { pid, startedAt } };
      } catch (error) {
        if (created) await removeFileQuietly(this.#lockPath); // 清理写入失败残留
        if (getErrnoCode(error) !== "EEXIST") {
          return { ok: false, warning: DEGRADE_WARNING }; // EACCES/EROFS/网络盘等
        }
        const outcome = await this.#handleExistingLock();
        if (outcome !== undefined) return outcome;
      }
    }
    return { ok: false, warning: DEGRADE_WARNING }; // 回收后仍冲突
  }

  /** 锁已存在：读 owner → 他人持有 / 死锁或过期则回收。 */
  async #handleExistingLock(): Promise<AcquireResult | undefined> {
    const owner = await FileLock.readOwner(this.#dir, this.#name);
    if (owner === undefined) {
      return { ok: false, warning: DEGRADE_WARNING }; // 锁文件存在但损坏/不可读
    }
    const stale = owner.startedAt + this.#staleMs <= Date.now();
    if (!stale && FileLock.isProcessAlive(owner.pid)) {
      return { ok: false }; // 他人持有
    }
    try {
      await unlink(this.#lockPath);
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") {
        return { ok: false, warning: DEGRADE_WARNING }; // 回收失败 → 降级
      }
    }
    return undefined; // 已回收，重试创建
  }

  /** 释放锁：停心跳 + 删除锁文件（幂等；仅持有者删除）。 */
  async release(): Promise<void> {
    if (this.#owner === undefined) return;
    this.#stopHeartbeat();
    this.#owner = undefined;
    await removeFileQuietly(this.#lockPath); // 删除失败（只读等）由 stale 回收兜底
  }

  /** 当前实例是否持有锁。 */
  isHeldBySelf(): boolean {
    return this.#owner !== undefined;
  }

  /** 心跳是否已降级（写失败被记录，不崩溃）。 */
  get heartbeatFailed(): boolean {
    return this.#heartbeatFailed;
  }

  /** 读锁信息；不存在/损坏/不可读 → undefined。 */
  static async readOwner(dir: string, name: string): Promise<LockOwner | undefined> {
    try {
      const text = await readFile(join(dir, `${name}.lock`), "utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const rec = parsed as Record<string, unknown>;
      const pid = rec["pid"];
      const startedAt = rec["startedAt"];
      if (typeof pid !== "number" || typeof startedAt !== "number") return undefined;
      return { pid, startedAt };
    } catch {
      return undefined;
    }
  }

  /** 进程存活探测：process.kill(pid,0)（ESRCH=死；EPERM=活）。 */
  static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return getErrnoCode(error) === "EPERM";
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeatMs <= 0) return;
    this.#timer = setInterval(() => {
      void this.#heartbeat();
    }, this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 心跳：刷新锁文件时间戳与 pid，避免被认为 stale；写失败记录降级不崩溃。 */
  async #heartbeat(): Promise<void> {
    if (this.#owner === undefined) return;
    const content = `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`;
    try {
      await writeFile(this.#lockPath, content, "utf8");
    } catch {
      this.#heartbeatFailed = true; // 记录降级状态
    }
  }
}

/** 提取 fs 错误的 errno code；非 Errno 错误返回 undefined。 */
function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
