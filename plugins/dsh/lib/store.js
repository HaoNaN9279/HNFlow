/**
 * Durable run records.
 *
 * Primary path: the DSH storage domain (`ctx.storageDomain`), which validates
 * records on open, writes atomically and emits `domain/changed`. Fallback: one
 * JSON file per run under `$DSH_HOME/hnflow/state`, used when the domain is not
 * mounted (a minimal composition) — the plugin says so in `degraded` rather
 * than pretending it is durable in the same way.
 *
 * Why one run document instead of one table per node/gate/artifact: the domain
 * has no cross-table transactions, and a run's state must advance atomically.
 * A run record therefore carries its nodes, pending human work and audit trail;
 * per-node evidence lives in the child sessions, which the run references.
 *
 * Published flow revisions are NOT stored here: they are immutable files in the
 * asset library (`assets.readRevisionRecord`), which is already the resolver's
 * source of truth. Keeping one copy is what stops a run from pinning a revision
 * the workspace resolver cannot see.
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { writeJson } from './assets.js'
import { stateDirectory } from './paths.js'

/** Domain name; a single instance is opened by the core service. */
export const DOMAIN_NAME = 'hnflow'
/** Domain version. Changing the record shape needs a manual migration or a bump. */
export const DOMAIN_VERSION = 1

/**
 * Wrap a validator as the zod-shaped schema the domain layer calls.
 * @param {(value: any) => void} validate - throws when the record is invalid.
 * @returns {{parse: (value: any) => any}} schema.
 */
function schemaOf(validate) {
  return {
    parse(value) {
      validate(value)
      return value
    },
  }
}

/**
 * Validate a run record's durable shape.
 * @param {any} value - candidate.
 * @returns {void}
 * @throws {Error} when required fields are missing.
 */
export function parseRunRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('run record must be an object')
  for (const field of ['runId', 'flowId', 'workspace', 'status']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) throw new Error(`run record.${field} must be a non-empty string`)
  }
  if (value.nodes === null || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) throw new Error('run record.nodes must be an object')
  if (!Array.isArray(value.pending)) throw new Error('run record.pending must be an array')
}

/** The domain declaration opened by the core service. */
export const HNFLOW_DOMAIN = Object.freeze({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  tables: {
    runs: { valueSchema: schemaOf(parseRunRecord) },
  },
})

/**
 * Create the record store.
 * @param {{
 *   storageDomain?: Record<string, any>,
 *   config: Record<string, any>,
 *   logger?: Record<string, any>,
 * }} options - wiring.
 * @returns {{
 *   open: () => Promise<void>,
 *   close: () => Promise<void>,
 *   mode: () => 'domain' | 'file',
 *   warnings: () => string[],
 *   getRun: (runId: string) => Promise<Record<string, any> | null>,
 *   listRuns: () => Promise<Record<string, any>[]>,
 *   putRun: (run: Record<string, any>) => Promise<void>,
 *   deleteRun: (runId: string) => Promise<void>,
 * }} store.
 */
export function createStore(options) {
  const config = options.config ?? {}
  const logger = options.logger ?? {}
  const storageDomain = options.storageDomain
  /** @type {Record<string, any> | null} */
  let domain = null
  /** @type {string[]} */
  const warnings = []
  const root = stateDirectory(config)

  const file = {
    /**
     * Read one JSON file.
     * @param {string} filePath - path.
     * @returns {Promise<any | null>} value or null.
     */
    async read(filePath) {
      try {
        return JSON.parse(await readFile(filePath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },

    /**
     * List run files.
     * @returns {Promise<Record<string, any>[]>} records.
     */
    async runs() {
      const dir = path.join(root, 'runs')
      /** @type {import('node:fs').Dirent[]} */
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
      /** @type {Record<string, any>[]} */
      const records = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8'))
          parseRunRecord(parsed)
          records.push(parsed)
        } catch (error) {
          logger.warn?.('hnflow: ignoring unreadable run file %s: %o', entry.name, error)
        }
      }
      return records
    },
  }

  return {
    /**
     * Open the durable store, degrading to files when the domain is absent.
     * @returns {Promise<void>} resolves once readable.
     */
    async open() {
      if (config.storage !== false && storageDomain !== null && storageDomain !== undefined && typeof storageDomain.open === 'function') {
        try {
          domain = await storageDomain.open(HNFLOW_DOMAIN)
          logger.info?.('hnflow: run state uses the storage domain %s', DOMAIN_NAME)
          return
        } catch (error) {
          warnings.push(`storage-degraded: ${String(error?.message ?? error)}`)
          logger.warn?.('hnflow: cannot open the storage domain; falling back to files: %o', error)
        }
      } else {
        warnings.push('storage-degraded: the storage domain is not mounted')
      }
      await mkdir(path.join(root, 'runs'), { recursive: true })
    },

    /**
     * Release the domain handle.
     * @returns {Promise<void>} resolves once closed.
     */
    async close() {
      if (domain !== null) {
        try {
          await domain.close()
        } catch (error) {
          logger.warn?.('hnflow: closing the storage domain failed: %o', error)
        }
        domain = null
      }
    },

    /**
     * Which backend is in use.
     * @returns {'domain' | 'file'} mode.
     */
    mode() {
      return domain === null ? 'file' : 'domain'
    },

    /**
     * Degradations observed while opening.
     * @returns {string[]} warnings.
     */
    warnings() {
      return [...warnings]
    },

    /**
     * Read one run.
     * @param {string} runId - run identity.
     * @returns {Promise<Record<string, any> | null>} record or null.
     */
    async getRun(runId) {
      if (domain !== null) return domain.table('runs').get(runId) ?? null
      return file.read(path.join(root, 'runs', `${runId}.json`))
    },

    /**
     * Read every run.
     * @returns {Promise<Record<string, any>[]>} records.
     */
    async listRuns() {
      if (domain !== null) {
        /** @type {Record<string, any>[]} */
        const records = []
        for (const [, value] of domain.table('runs').entries()) records.push(value)
        return records
      }
      return file.runs()
    },

    /**
     * Write one run document.
     * @param {Record<string, any>} run - record.
     * @returns {Promise<void>} resolves once durable.
     */
    async putRun(run) {
      parseRunRecord(run)
      if (domain !== null) {
        await domain.table('runs').put(run.runId, run)
        return
      }
      await writeJson(path.join(root, 'runs', `${run.runId}.json`), run)
    },

    /**
     * Remove a run (an explicit purge; the page never calls this).
     * @param {string} runId - run identity.
     * @returns {Promise<void>} resolves once removed.
     */
    async deleteRun(runId) {
      if (domain !== null) {
        await domain.table('runs').delete(runId)
        return
      }
      await rm(path.join(root, 'runs', `${runId}.json`), { force: true })
    },
  }
}
