/**
 * Run health: one sentence the owner can act on.
 *
 * Mirrors superagent's Report idea without importing its six states: the value
 * is "why is this run not moving, and who is it waiting for", derived from the
 * fields the run already has. Pure function so the page, the tool and the tests
 * agree on the same sentence.
 */

import { stageOf } from './inbox.js'

/** Statuses that never advance again. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/** Milliseconds without progress before a running run is called stalled. */
export const STALL_MS = 60_000

/**
 * Latest timestamp on a run.
 * @param {Record<string, any>} run - run record.
 * @returns {number} epoch milliseconds.
 */
function lastActivity(run) {
  /** @type {number[]} */
  const stamps = []
  for (const value of [run.updatedAt, run.endedAt, run.startedAt, run.createdAt]) {
    const stamp = Date.parse(String(value ?? ''))
    if (Number.isFinite(stamp)) stamps.push(stamp)
  }
  for (const state of Object.values(run.nodes ?? {})) {
    for (const value of [state?.startedAt, state?.endedAt]) {
      const stamp = Date.parse(String(value ?? ''))
      if (Number.isFinite(stamp)) stamps.push(stamp)
    }
  }
  return stamps.length === 0 ? 0 : Math.max(...stamps)
}

/**
 * Find the node a health message should point at.
 * @param {Record<string, any>} run - run record.
 * @returns {string | null} node id.
 */
function focusNode(run) {
  if (typeof run.error?.nodes?.[0]?.nodeId === 'string') return run.error.nodes[0].nodeId
  for (const [id, state] of Object.entries(run.nodes ?? {})) {
    if (state?.status === 'failed' || state?.status === 'blocked') return id
  }
  for (const [id, state] of Object.entries(run.nodes ?? {})) {
    if (state?.status === 'running') return id
  }
  const open = (run.pending ?? []).filter((entry) => entry.decision === undefined && entry.delivery === undefined)
  return open.length > 0 ? String(open[0].nodeId ?? '') || null : null
}

/**
 * Derive the health of one run.
 * @param {Record<string, any>} run - run record.
 * @param {{now?: Date}} [options] - clock.
 * @returns {{state: string, code: string, nodeId: string | null, waitingOn: 'owner' | 'model' | 'host' | null, message: string, since: string | null}} health.
 */
export function runHealth(run, options = {}) {
  const nowMs = (options.now ?? new Date()).getTime()
  const nodeId = focusNode(run)
  const since = typeof run.updatedAt === 'string' ? run.updatedAt : typeof run.startedAt === 'string' ? run.startedAt : null
  if (run.status === 'succeeded') {
    return { state: 'succeeded', code: 'ok', nodeId: null, waitingOn: null, message: `已完成${run.endedAt === undefined ? '' : ''}`, since: run.endedAt ?? since }
  }
  if (run.status === 'cancelled') {
    return { state: 'cancelled', code: 'ok', nodeId: null, waitingOn: null, message: '已取消', since: run.endedAt ?? since }
  }
  if (run.status === 'failed') {
    const code = String(run.error?.code ?? 'run-failed')
    const reason = String(run.error?.message ?? '运行失败').split('\n')[0]
    return { state: 'failed', code, nodeId, waitingOn: null, message: `失败：${reason}`, since: run.endedAt ?? since }
  }
  if (run.status === 'interrupted') {
    const code = String(run.error?.code ?? 'host-restarted')
    const message = code === 'host-unavailable' ? '没有可用的宿主会话，运行已中断；resume 会在需要时新建 conductor' : '宿主重启打断了运行，resume 可继续'
    return { state: 'interrupted', code, nodeId, waitingOn: 'host', message, since: run.error?.at ?? since }
  }
  if (run.status === 'waiting_human') {
    const open = (run.pending ?? []).filter((entry) => entry.decision === undefined && entry.delivery === undefined)
    const pending = open[0]
    if (pending === undefined) {
      return { state: 'waiting_human', code: 'waiting-decision', nodeId, waitingOn: 'owner', message: '等待人的决定', since }
    }
    const { stage, label } = stageOf(pending)
    const title = pending.nodeTitle ?? pending.nodeId ?? '节点'
    const code = stage === 'deliver' || stage === 'rework' ? 'waiting-delivery' : stage === 'arbitrate' ? 'waiting-arbitration' : 'waiting-decision'
    return {
      state: 'waiting_human',
      code,
      nodeId: String(pending.nodeId ?? '') || nodeId,
      waitingOn: 'owner',
      message: `${open.length > 1 ? `还有 ${open.length} 项，先处理：` : ''}${label} · ${title}`,
      since: pending.createdAt ?? since,
    }
  }
  if (run.status === 'running') {
    const last = lastActivity(run)
    const stale = last > 0 && nowMs - last > STALL_MS
    return {
      state: 'running',
      code: stale ? 'stalled' : 'ok',
      nodeId,
      waitingOn: 'model',
      message: stale ? `超过 ${Math.round((nowMs - last) / 1000)} 秒没有进展：${nodeId ?? '调度中'}` : `正在执行${nodeId === null ? '' : ` ${nodeId}`}`,
      since: last === 0 ? since : new Date(last).toISOString(),
    }
  }
  return { state: String(run.status ?? 'queued'), code: 'ok', nodeId, waitingOn: null, message: '排队中', since }
}

/**
 * Whether a run is in a state that can still move.
 * @param {Record<string, any>} run - run record.
 * @returns {boolean} true when not terminal.
 */
export function isOpen(run) {
  return TERMINAL.has(run.status) === false
}
