/**
 * The service facade: what a run freezes, and what stays workspace-local.
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HnflowService } from '../lib/service.js'

/** A minimal start → assign → end definition. */
function definition(value) {
  return {
    id: 'hello-workflow',
    name: 'Hello workflow',
    version: '0.1.0',
    nodes: [
      { id: 'start', type: 'flow:start', outputs: [{ name: 'out', type: 'data' }] },
      { id: 'greet', type: 'data:assign', inputs: [{ name: 'in', type: 'data' }], outputs: [{ name: 'out', type: 'data' }], params: { value } },
      { id: 'end', type: 'flow:end', inputs: [{ name: 'in', type: 'data' }] },
    ],
    edges: [
      { source: 'start', source_port: 'out', target: 'greet', target_port: 'in' },
      { source: 'greet', source_port: 'out', target: 'end', target_port: 'in' },
    ],
  }
}

/**
 * A service with an isolated library and a scripted engine.
 * @param {string[]} calls - collects `run/start` payloads.
 * @returns {Promise<{service: HnflowService, cwd: string}>} fixture.
 */
async function makeService(calls = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-service-'))
  const engine = {
    ensureStarted: async () => ({ protocolVersion: 1 }),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'run/start') return { runId: 'run-1', status: 'queued', startedAt: 'now' }
      if (method === 'run/status') return { runId: 'run-1', status: 'succeeded', result: { in: 'ok' }, nodes: [], error: null }
      if (method === 'run/cancel') return { runId: 'run-1', status: 'running', cancelled: true }
      return {}
    },
    stop: () => {},
  }
  const service = new HnflowService({ config: { libraryRoot: path.join(root, 'library') }, engine })
  const cwd = path.join(root, 'workspace')
  return { service, cwd }
}

test('a run freezes the resolved definition and its provenance', async () => {
  const calls = []
  const { service, cwd } = await makeService(calls)
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })
  await stores.workspace.writeOverride({ assetId: created.asset.id, definition: definition('override'), baseRevision: 1, origin: 'agent' })

  const started = await service.startRun({ cwd, key: 'hello', inputs: { target: 'staging' } })

  assert.equal(started.runId, 'run-1')
  assert.equal(started.resolved.source, 'override')
  const runStart = calls.find((call) => call.method === 'run/start')
  assert.equal(runStart.params.definition.nodes[1].params.value, 'override')
  assert.deepEqual(runStart.params.inputs, { target: 'staging' })
  assert.equal(runStart.params.metadata.workflowSource, 'override')
  assert.equal(runStart.params.metadata.workspace, cwd)
  assert.equal(service.runs.get('run-1').key, 'hello')
})

test('writing an override never touches the asset', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })

  const override = await service.writeOverride({ cwd, key: 'hello', definition: definition('local'), note: '本项目用途', origin: 'agent' })

  assert.equal(override.baseRevision, 1)
  assert.equal(override.origin, 'agent')
  assert.equal((await stores.assets.read(created.asset.id)).asset.revision, 1)
  assert.equal((await stores.assets.read(created.asset.id)).definition.nodes[1].params.value, 'asset')
  assert.equal((await service.resolve(cwd, 'hello')).definition.nodes[1].params.value, 'local')
})

test('resetting an override restores the asset revision', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })
  await service.writeOverride({ cwd, key: 'hello', definition: definition('local') })

  const reset = await service.resetOverride({ cwd, key: 'hello' })

  assert.equal(reset.removed, true)
  assert.equal((await service.resolve(cwd, 'hello')).definition.nodes[1].params.value, 'asset')
})

test('the prompt index lists refs and marks overrides', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset'), description: 'demo' })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })

  const section = await service.indexSection(cwd)
  assert.match(section, /Call the `hnflow` tool/u)
  assert.match(section, /- hello — demo/u)
  assert.equal(await service.indexSection(path.join(cwd, 'empty')), '')
})

test('dispose stops the engine and clears caches', async () => {
  let stopped = false
  const { service, cwd } = await makeService()
  service.engine = { stop: () => { stopped = true } }
  service.storesFor(cwd)
  service.dispose()

  assert.equal(stopped, true)
  assert.equal(service.engine, null)
  assert.equal(service.storesByCwd.size, 0)
})
