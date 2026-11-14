/**
 * Durable side effects.
 *
 * Some things a run must do are outside the run document: telling the owner it
 * finished, or starting the flow that was declared to follow it. Doing them
 * inline is "fire and forget": a crash between the state change and the effect
 * loses it, and a retry can duplicate it. So effects are recorded first
 * (`enqueue`), then executed by the pass (`drain`), with a stable `kind+key`
 * making a duplicate record harmless.
 *
 * Storage is one JSON file under the plugin state directory. Effects are small
 * and low-volume; a second database would only add a failure mode.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { readJsonOrNull, writeJson } from './assets.js'

/** File format version. */
export const OUTBOX_VERSION = 1

/** Backoff cap in milliseconds. */
const MAX_BACKOFF_MS = 60_000

/**
 * Create the effect queue.
 * @param {{
 *   dir: string,
 *   now?: () => Date,
 *   logger?: Record<string, any>,
 *   maxAttempts?: number,
 *   limit?: number,
 * }} options - wiring.
 * @returns {{
 *   open: () => Promise<void>,
 *   list: (options?: {limit?: number}) => Record<string, any>[],
 *   due: (at?: Date) => Record<string, any>[],
 *   enqueue: (effect: Record<string, any>) => Promise<Record<string, any>>,
 *   markDone: (id: string, note?: string) => Promise<void>,
 *   markFailed: (id: string, error: string) => Promise<void>,
 *   summary: () => {pending: number, dead: number, done: number, recent: Record<string, any>[]},
 * }} outbox.
 */
export function createOutbox(options) {
  const dir = options.dir
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? {}
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 8
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 500
  const file = path.join(dir, 'outbox.json')
  /** @type {Record<string, any>[]} */
  let items = []
  let loaded = false
  /** @type {Promise<any>} */
  let chain = Promise.resolve()

  /**
   * Serialize mutations so two concurrent drains cannot clobber the file.
   * @template T
   * @param {() => Promise<T>} job - mutation.
   * @returns {Promise<T>} result.
   */
  function locked(job) {
    const next = chain.then(job, job)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Load the file once.
   * @returns {Promise<void>} resolves once loaded.
   */
  async function load() {
    if (loaded) return
    const parsed = await readJsonOrNull(file)
    items = Array.isArray(parsed?.items) ? parsed.items : []
    loaded = true
  }

  /**
   * Persist the queue, dropping the oldest finished entries beyond the limit.
   * @returns {Promise<void>} resolves once durable.
   */
  async function save() {
    if (items.length > limit) {
      const keep = [...items]
        .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
        .slice(0, limit)
      items = keep.sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
    }
    await writeJson(file, { version: OUTBOX_VERSION, items })
  }

  return {
    /**
     * Read the queue from disk.
     * @returns {Promise<void>} resolves once readable.
     */
    async open() {
      await load()
    },

    /**
     * Every effect, newest first.
     * @param {{limit?: number}} [query] - bound.
     * @returns {Record<string, any>[]} effects.
     */
    list(query = {}) {
      const bound = Number.isInteger(query.limit) ? query.limit : 20
      return [...items].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''))).slice(0, bound)
    },

    /**
     * Pending effects that are due.
     * @param {Date} [at] - instant.
     * @returns {Record<string, any>[]} due effects, oldest first.
     */
    due(at = now()) {
      const stamp = at.getTime()
      return items
        .filter((item) => item.status === 'pending' && Date.parse(String(item.nextAt ?? item.createdAt ?? '')) <= stamp)
        .sort((left, right) => String(left.nextAt ?? left.createdAt ?? '').localeCompare(String(right.nextAt ?? right.createdAt ?? '')))
    },

    /**
     * Record one effect unless the same `kind+key` is already live.
     * @param {{kind: string, key: string, payload?: Record<string, any>, runId?: string}} effect - effect.
     * @returns {Promise<Record<string, any>>} stored effect.
     */
    async enqueue(effect) {
      return locked(async () => {
        await load()
        const kind = String(effect?.kind ?? '')
        const key = String(effect?.key ?? '')
        if (kind.length === 0 || key.length === 0) throw new Error('an effect needs kind and key')
        const existing = items.find((item) => item.kind === kind && item.key === key && item.status !== 'dead')
        if (existing !== undefined) return existing
        const stamp = now()
        const record = {
          id: `eff-${randomUUID().slice(0, 12)}`,
          kind,
          key,
          runId: typeof effect.runId === 'string' ? effect.runId : undefined,
          payload: effect.payload ?? {},
          status: 'pending',
          attempts: 0,
          createdAt: stamp.toISOString(),
          nextAt: stamp.toISOString(),
          lastError: null,
        }
        items.push(record)
        await save()
        return record
      })
    },

    /**
     * Mark one effect done.
     * @param {string} id - effect id.
     * @param {string} [note] - outcome note.
     * @returns {Promise<void>} resolves once durable.
     */
    async markDone(id, note) {
      await locked(async () => {
        await load()
        const item = items.find((entry) => entry.id === id)
        if (item === undefined) return
        item.status = 'done'
        item.doneAt = now().toISOString()
        item.note = note ?? null
        await save()
      })
    },

    /**
     * Record a failed attempt and schedule the next one.
     * @param {string} id - effect id.
     * @param {string} error - failure text.
     * @returns {Promise<void>} resolves once durable.
     */
    async markFailed(id, error) {
      await locked(async () => {
        await load()
        const item = items.find((entry) => entry.id === id)
        if (item === undefined) return
        item.attempts = Number(item.attempts ?? 0) + 1
        item.lastError = String(error ?? 'unknown error')
        if (item.attempts >= maxAttempts) {
          item.status = 'dead'
          item.nextAt = null
          logger.warn?.('hnflow: effect %s (%s) is dead after %d attempts: %s', item.id, item.kind, item.attempts, item.lastError)
        } else {
          const backoff = Math.min(2 ** item.attempts * 1000, MAX_BACKOFF_MS)
          item.nextAt = new Date(now().getTime() + backoff).toISOString()
        }
        await save()
      })
    },

    /**
     * Counts plus the most recent entries, for the page.
     * @returns {{pending: number, dead: number, done: number, recent: Record<string, any>[]}} summary.
     */
    summary() {
      const pending = items.filter((item) => item.status === 'pending').length
      const dead = items.filter((item) => item.status === 'dead').length
      const done = items.filter((item) => item.status === 'done').length
      const recent = [...items]
        .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
        .slice(0, 20)
        .map(({ id, kind, key, status, attempts, createdAt, lastError, payload }) => ({ id, kind, key, status, attempts, createdAt, lastError, payload }))
      return { pending, dead, done, recent }
    },
  }
}
