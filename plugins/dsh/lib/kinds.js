/**
 * Node kind registry.
 *
 * The six built-in kinds stay native: they are the contract of the language and
 * their validation deserves hand-written rules. This registry is the extension
 * seam for everything else, and it is deliberately narrow: an extra kind is a
 * deterministic in-process function. It cannot spawn a child, read the network
 * or run a script — those are the two powers that make a flow unreviewable.
 */

import { NODE_TYPES } from './flow/definition.js'

/** Kind ids look like node ids: lower-case words joined by dashes. */
const KIND_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,4}$/u

/**
 * Create an empty registry that refuses to shadow built-ins.
 * @param {{builtin?: string[]}} [options] - built-in kinds.
 * @returns {{
 *   register: (kind: Record<string, any>) => Record<string, any>,
 *   get: (id: string) => Record<string, any> | undefined,
 *   has: (id: string) => boolean,
 *   list: () => Record<string, any>[],
 *   unregister: (id: string) => boolean,
 * }} registry.
 */
export function createKindRegistry(options = {}) {
  const builtin = new Set(options.builtin ?? NODE_TYPES)
  /** @type {Map<string, Record<string, any>>} */
  const kinds = new Map()
  return {
    /**
     * Register one extra kind.
     * @param {Record<string, any>} kind - `{id, title?, description?, run}`.
     * @returns {Record<string, any>} the registered kind.
     * @throws {Error} when the kind is malformed or shadows a built-in.
     */
    register(kind) {
      const id = String(kind?.id ?? '')
      if (!KIND_ID.test(id)) throw new Error(`node kind id ${JSON.stringify(id)} must match ${KIND_ID.source}`)
      if (builtin.has(id)) throw new Error(`node kind ${id} is built in and cannot be replaced`)
      if (kinds.has(id)) throw new Error(`node kind ${id} is already registered`)
      if (typeof kind?.run !== 'function') throw new Error(`node kind ${id} needs a run(context) function`)
      const record = Object.freeze({
        id,
        title: typeof kind.title === 'string' && kind.title.length > 0 ? kind.title : id,
        description: typeof kind.description === 'string' ? kind.description : '',
        run: kind.run,
      })
      kinds.set(id, record)
      return record
    },

    /**
     * Read one kind.
     * @param {string} id - kind id.
     * @returns {Record<string, any> | undefined} kind.
     */
    get(id) {
      return kinds.get(String(id))
    },

    /**
     * Whether a kind is registered.
     * @param {string} id - kind id.
     * @returns {boolean} true when present.
     */
    has(id) {
      return kinds.has(String(id))
    },

    /**
     * Every registered kind.
     * @returns {Record<string, any>[]} kinds.
     */
    list() {
      return [...kinds.values()]
    },

    /**
     * Remove one kind (tests and hot reload).
     * @param {string} id - kind id.
     * @returns {boolean} true when removed.
     */
    unregister(id) {
      return kinds.delete(String(id))
    },
  }
}

/**
 * Normalise the value an extra kind returns.
 * @param {any} value - raw return value.
 * @param {string} id - kind id.
 * @returns {{status: 'done', output: any} | {status: 'failed', diagnostic: Record<string, any>}} result.
 */
export function normalizeKindResult(value, id) {
  if (value === null || typeof value !== 'object') {
    return { status: 'failed', diagnostic: { code: 'node-failed', message: `node kind ${id} returned no result object` } }
  }
  if (value.status === 'done') return { status: 'done', output: value.output }
  if (value.status === 'failed') {
    return {
      status: 'failed',
      diagnostic: {
        code: String(value.diagnostic?.code ?? 'node-failed'),
        message: String(value.diagnostic?.message ?? `node kind ${id} failed`),
      },
    }
  }
  return { status: 'failed', diagnostic: { code: 'node-failed', message: `node kind ${id} must return status "done" or "failed"` } }
}
