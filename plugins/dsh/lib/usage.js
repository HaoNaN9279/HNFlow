/**
 * Token usage attribution.
 *
 * A node is a subagent session; its model calls are ordinary
 * `assistant/message` events with a `usage` field. When the child session is
 * still live the service can fold those events into a per-node number — which
 * is the honest answer to "what did this node cost". When the session is gone
 * the answer is `null`, not a guess: an estimate would silently mix real usage
 * with heuristic pricing.
 */

/** A zero total usable as an accumulator. */
export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }
}

/**
 * Sum the usage of one session's assistant messages.
 * @param {{snapshotEvents?: Function, ownEvents?: Function} | null | undefined} session - live DSH session.
 * @returns {Record<string, number> | null} usage total, or null when unreadable.
 */
export function usageFromSession(session) {
  if (session === null || session === undefined) return null
  /** @type {any[]} */
  let events = []
  try {
    // `ownEvents()` reads the live session tail; `snapshotEvents()` may only
    // expose the durable prefix before the next flush.
    if (typeof session.ownEvents === 'function') events = [...session.ownEvents()]
    else if (typeof session.snapshotEvents === 'function') events = [...session.snapshotEvents()]
    else return null
  } catch {
    return null
  }
  const total = emptyUsage()
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const usage = event?.data?.usage
    if (usage === null || typeof usage !== 'object') continue
    total.calls += 1
    total.inputTokens += Number(usage.inputTokens ?? 0)
    total.outputTokens += Number(usage.outputTokens ?? 0)
    total.cacheReadTokens += Number(usage.cacheReadTokens ?? 0)
    total.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0)
  }
  total.totalTokens = total.inputTokens + total.outputTokens
  return total
}

/**
 * Add one node's usage into a run total.
 * @param {Record<string, number> | null | undefined} total - accumulated run usage.
 * @param {Record<string, number> | null | undefined} delta - node usage.
 * @returns {Record<string, number> | null} new total.
 */
export function addUsage(total, delta) {
  if (delta === null || delta === undefined) return total ?? null
  const base = total ?? emptyUsage()
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    totalTokens: base.totalTokens + delta.totalTokens,
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    calls: base.calls + delta.calls,
  }
}
