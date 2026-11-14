/**
 * Per-project plan cache.
 *
 * `hnflow-stack resolve` is a subprocess, so a session must not pay for it on
 * every step. A cached active plan stays valid until `.hnflow/stack.json`
 * changes; an inactive plan is re-checked after a short delay so creating the
 * file is noticed without restarting anything.
 */

import { statSync } from 'node:fs'
import path from 'node:path'

const INACTIVE_TTL_MS = 15_000

/**
 * Cache one resolve result per project directory.
 */
export class PlanCache {
  #resolve
  #now
  #entries = new Map()

  /**
   * @param {(projectDir: string) => Promise<{plan: Record<string, unknown> | null, warnings: string[]}>} resolve - resolver.
   * @param {{now?: () => number}} [options] - injectable clock for tests.
   */
  constructor(resolve, options = {}) {
    this.#resolve = resolve
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Fingerprint the project stack file.
   * @param {string} projectDir - absolute project directory.
   * @returns {string} `mtime:size`, or an empty string when absent.
   */
  static stackStamp(projectDir) {
    try {
      const stat = statSync(path.join(projectDir, '.hnflow', 'stack.json'))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return ''
    }
  }

  /**
   * Return a cached or freshly resolved plan.
   * @param {string} projectDir - absolute project directory.
   * @returns {Promise<{plan: Record<string, unknown> | null, warnings: string[]}>} plan and warnings.
   */
  async get(projectDir) {
    const key = path.resolve(projectDir)
    const stamp = PlanCache.stackStamp(key)
    const cached = this.#entries.get(key)
    if (cached && cached.stamp === stamp) {
      if (cached.inflight) return cached.inflight
      if (cached.result.plan && cached.result.plan.active) return cached.result
      if (cached.result.plan && this.#now() - cached.at < INACTIVE_TTL_MS) return cached.result
    }
    if (cached && cached.inflight) return cached.inflight

    const entry = { stamp, at: this.#now(), result: { plan: null, warnings: [] }, inflight: null }
    entry.inflight = (async () => {
      try {
        const result = await this.#resolve(key)
        entry.result = result
        return result
      } finally {
        entry.at = this.#now()
        entry.inflight = null
        this.#entries.set(key, entry)
      }
    })()
    this.#entries.set(key, entry)
    return entry.inflight
  }

  /**
   * Read a cached plan without resolving anything.
   *
   * Synchronous by design: system-prompt sections and connection-free readers
   * cannot await a subprocess.
   * @param {string} projectDir - absolute project directory.
   * @returns {Record<string, unknown> | null} cached plan for the current stack, or null.
   */
  peek(projectDir) {
    const key = path.resolve(projectDir)
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    if (entry.inflight !== null) return entry.result.plan ?? null
    if (entry.stamp !== PlanCache.stackStamp(key)) return null
    return entry.result.plan ?? null
  }

  /**
   * Drop the cached plan for one project.
   * @param {string} projectDir - absolute project directory.
   * @returns {void}
   */
  invalidate(projectDir) {
    this.#entries.delete(path.resolve(projectDir))
  }

  /**
   * Drop every cached plan.
   * @returns {void}
   */
  clear() {
    this.#entries.clear()
  }
}
