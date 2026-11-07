/**
 * The record store: domain path, file fallback, and record validation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HNFLOW_DOMAIN, createStore, parseRunRecord } from '../lib/store.js'

/**
 * A minimal domain handle with the table API the store uses.
 * @returns {Record<string, any>} domain facility.
 */
function fakeDomain() {
  /** @type {Map<string, Map<string, any>>} */
  const tables = new Map()
  for (const name of Object.keys(HNFLOW_DOMAIN.tables)) tables.set(name, new Map())
  return {
    opened: 0,
    closed: 0,
    async open(spec) {
      this.opened += 1
      assert.equal(spec.name, 'hnflow')
      return {
        table: (name) => ({
          get: (key) => tables.get(name).get(key),
          put: async (key, value) => {
            tables.get(name).set(key, value)
          },
          delete: async (key) => tables.get(name).delete(key),
          entries: () => tables.get(name).entries(),
        }),
        close: async () => {
          this.closed += 1
        },
      }
    },
  }
}

/**
 * A minimal run record.
 * @param {string} [runId] - identity.
 * @returns {Record<string, any>} record.
 */
function runRecord(runId = 'run-1') {
  return { runId, flowId: 'fl', workspace: '/w', status: 'running', nodes: {}, pending: [] }
}

test('the domain path validates and round-trips a run', async () => {
  const domain = fakeDomain()
  const store = createStore({ storageDomain: domain, config: {}, logger: {} })
  await store.open()
  assert.equal(store.mode(), 'domain')
  await store.putRun(runRecord())
  assert.equal((await store.getRun('run-1')).status, 'running')
  assert.equal((await store.listRuns()).length, 1)
  await store.deleteRun('run-1')
  assert.equal(await store.getRun('run-1'), null)
  await store.close()
  assert.equal(domain.closed, 1)
})

test('an invalid record is refused before it reaches the backend', async () => {
  const domain = fakeDomain()
  const store = createStore({ storageDomain: domain, config: {}, logger: {} })
  await store.open()
  await assert.rejects(() => store.putRun({ runId: 'x' }), /flowId/u)
  assert.throws(() => parseRunRecord(null), /must be an object/u)
})

test('the file fallback is used when the domain is absent, and says so', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-store-'))
  try {
    const store = createStore({ config: { stateDir: root }, logger: {} })
    await store.open()
    assert.equal(store.mode(), 'file')
    assert.equal(store.warnings().some((warning) => warning.startsWith('storage-degraded')), true)
    await store.putRun(runRecord('run-file'))
    assert.equal((await store.getRun('run-file')).status, 'running')
    const raw = JSON.parse(await readFile(path.join(root, 'runs', 'run-file.json'), 'utf8'))
    assert.equal(raw.runId, 'run-file')
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a broken domain open degrades to files instead of failing the plugin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-store-'))
  try {
    const store = createStore({
      storageDomain: {
        open: async () => {
          throw new Error('backend is down')
        },
      },
      config: { stateDir: root },
      logger: {},
    })
    await store.open()
    assert.equal(store.mode(), 'file')
    assert.match(store.warnings()[0], /storage-degraded: backend is down/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
