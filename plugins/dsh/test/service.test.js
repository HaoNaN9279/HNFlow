/**
 * The service facade: what a run freezes, and what stays workspace-local.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HnflowService } from '../lib/service.js'

/** A minimal start 鈫?assign 鈫?end definition. */
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
      if (method === 'workflow/validate') return { valid: true, errors: [] }
      return {}
    },
    stop: () => {},
  }
  const service = new HnflowService({ config: { libraryRoot: path.join(root, 'library') }, engine })
  const cwd = path.join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  return { service, cwd }
}

test('an engine restart resumes the runs it interrupted', async () => {
  /** @type {string[]} */
  const resumed = []
  const service = new HnflowService({
    config: {},
    engine: {
      ensureStarted: async () => ({ protocolVersion: 1 }),
      request: async (method, params) => {
        if (method === 'run/list') {
          return {
            runs: [
              { runId: 'run-a', status: 'interrupted' },
              { runId: 'run-b', status: 'waiting_human' },
              { runId: 'run-c', status: 'succeeded' },
            ],
          }
        }
        if (method === 'run/resume') {
          resumed.push(params.runId)
          return { runId: params.runId, status: 'running' }
        }
        return {}
      },
    },
  })

  const outcome = await service.resumeInterrupted()

  // A run waiting on a human is not ours to restart.
  assert.deepEqual(resumed, ['run-a'])
  assert.deepEqual(outcome.resumed, ['run-a'])
  assert.deepEqual(outcome.failed, [])
})

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

test('saving an asset bumps its revision and leaves refs pinned', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })
  const override = await service.writeOverride({ cwd, key: 'hello', definition: definition('local'), note: '本项目用途', origin: 'agent' })

  const saved = await service.saveAsset({ cwd, key: 'hello', note: 'back to the asset' })

  assert.equal(saved.previousRevision, 1)
  assert.equal(saved.revision, 2)
  assert.equal((await stores.assets.read(created.asset.id)).definition.nodes[1].params.value, 'local')
  // The ref still pins r1, so this workspace keeps running what it ran before.
  assert.equal((await service.resolve(cwd, 'hello')).definition.nodes[1].params.value, 'local')
  assert.equal((await stores.assets.readRevision(created.asset.id, 1)).nodes[1].params.value, 'asset')
})

test('an asset cannot be saved without a workspace override', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })

  await assert.rejects(service.saveAsset({ cwd, key: 'hello' }), (error) => error.code === 'nothing-to-save')
})

test('validation and schema go to the engine', async () => {
  const calls = []
  const { service } = await makeService(calls)
  service.engine = {
    ensureStarted: async () => ({}),
    stop: () => {},
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'workflow/validate') return { valid: true, errors: [] }
      return { nodeTypes: [], portTypes: [] }
    },
  }

  assert.deepEqual(await service.validateDefinition({ id: 'w' }), { valid: true, errors: [] })
  assert.deepEqual(await service.schema(), { nodeTypes: [], portTypes: [] })
  assert.equal(calls[0].method, 'workflow/validate')
  assert.equal(calls[1].method, 'workflow/describe')
})

test('a new asset starts as a runnable start → end scaffold', async () => {
  const { service, cwd } = await makeService()
  const created = await service.createAsset({ cwd, name: 'Release flow' })

  assert.equal(created.name, 'Release flow')
  assert.equal(created.revision, 1)
  const stores = service.storesFor(cwd)
  const stored = await stores.assets.read(created.assetId)
  assert.deepEqual(
    stored.definition.nodes.map((node) => node.type),
    ['flow:start', 'flow:end'],
  )
  assert.equal(stored.definition.id, 'release-flow')

  await stores.workspace.addRef({ assetId: created.assetId, alias: 'release', revision: 1 })
  assert.equal((await service.resolve(cwd, 'release')).definition.id, 'release-flow')
})

test('import accepts the asset, engine, and bare shapes', async () => {
  const { service, cwd } = await makeService()
  const shapes = {
    'asset.workflow.json': { asset: { id: 'wf-x' }, definition: definition('from-asset') },
    'engine.workflow.json': { schema_version: 1, workflow: definition('from-engine') },
    'bare.workflow.json': definition('from-bare'),
  }
  for (const [name, body] of Object.entries(shapes)) {
    await writeFile(path.join(cwd, name), JSON.stringify(body), 'utf8')
  }

  for (const [name, expected] of [
    ['asset.workflow.json', 'from-asset'],
    ['engine.workflow.json', 'from-engine'],
    ['bare.workflow.json', 'from-bare'],
  ]) {
    const imported = await service.importAsset({ cwd, path: name })
    const stored = await service.storesFor(cwd).assets.read(imported.assetId)
    assert.equal(stored.definition.nodes[1].params.value, expected)
  }
})

test('import failures are coded, not thrown raw', async () => {
  const { service, cwd } = await makeService()
  await writeFile(path.join(cwd, 'junk.json'), '{"nope": true}', 'utf8')

  await assert.rejects(service.importAsset({ cwd, path: 'junk.json' }), (error) => error.code === 'import-invalid')
  await assert.rejects(service.importAsset({ cwd, path: 'missing.json' }), (error) => error.code === 'import-unreadable')
})

test('an asset cannot be deleted while this workspace references it', async () => {
  const { service, cwd } = await makeService()
  const created = await service.createAsset({ cwd, name: 'Keep me' })
  const stores = service.storesFor(cwd)
  await stores.workspace.addRef({ assetId: created.assetId, alias: 'keep', revision: 1 })

  await assert.rejects(service.deleteAsset({ cwd, assetId: created.assetId }), (error) => error.code === 'asset-in-use')

  await stores.workspace.removeRef('keep')
  const removed = await service.deleteAsset({ cwd, assetId: created.assetId })
  assert.equal(removed.assetId, created.assetId)
  assert.deepEqual(await stores.assets.list(), [])
})

test('repin moves a ref onto the saved revision', async () => {
  const { service, cwd } = await makeService()
  const created = await service.createAsset({ cwd, name: 'Release' })
  const stores = service.storesFor(cwd)
  await stores.workspace.addRef({ assetId: created.assetId, alias: 'release', revision: 1 })
  await service.writeOverride({ cwd, key: 'release', definition: definition('local') })
  await service.saveAsset({ cwd, key: 'release' })

  const pinned = await service.repinRef({ cwd, key: 'release' })
  assert.equal(pinned.revision, 2)
  const after = await service.resolve(cwd, 'release')
  // The override still wins, so behaviour stays the same until it is reset.
  assert.equal(after.source, 'override')
  await service.resetOverride({ cwd, key: 'release' })
  assert.equal((await service.resolve(cwd, 'release')).definition.nodes[1].params.value, 'local')

  const following = await service.repinRef({ cwd, key: 'release', revision: null })
  assert.equal(following.revision, null)
})

test('the panel payload carries the catalogue and one definition', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })
  await stores.workspace.writeOverride({ assetId: created.asset.id, definition: definition('local'), baseRevision: 1 })

  const payload = await service.panelPayload(cwd)

  assert.equal(payload.workspace, cwd)
  assert.equal(payload.workflows.length, 1)
  assert.equal(payload.workflows[0].alias, 'hello')
  assert.equal(payload.workflows[0].hasOverride, true)
  assert.equal(payload.selected.key, 'hello')
  assert.equal(payload.selected.source, 'override')
  assert.equal(payload.selected.definition.nodes[1].params.value, 'local')
})

test('a broken selection yields selected:null instead of failing the panel', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  await stores.workspace.addRef({ assetId: 'wf-gone', alias: 'gone', revision: null })

  const payload = await service.panelPayload(cwd, 'gone')

  assert.equal(payload.workflows[0].missing, true)
  assert.equal(payload.selected, null)
})

test('editing one node writes an override and leaves the asset alone', async () => {
  const calls = []
  const { service, cwd } = await makeService(calls)
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })

  const result = await service.setNodeParams({ cwd, key: 'hello', nodeId: 'greet', params: { value: 'edited' } })

  assert.equal(result.nodeId, 'greet')
  assert.equal((await stores.assets.read(created.asset.id)).definition.nodes[1].params.value, 'asset')
  const override = await stores.workspace.readOverride(created.asset.id)
  assert.equal(override.definition.nodes[1].params.value, 'edited')
  assert.equal(override.origin, 'user')
  assert.match(override.changeLog[0].summary, /panel: node greet/u)
  assert.equal(calls.some((call) => call.method === 'workflow/validate'), true)
})

test('a rejected edit writes nothing', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })
  const accepting = service.engine
  service.engine = { ...accepting, request: async (method) => (method === 'workflow/validate' ? { valid: false, errors: ['bad params'] } : {}) }

  await assert.rejects(service.setNodeParams({ cwd, key: 'hello', nodeId: 'greet', params: { value: 'x' } }), (error) => error.code === 'definition-invalid')
  assert.equal(await stores.workspace.readOverride(created.asset.id), null)
})

test('editing rejects an unknown node and non-object params', async () => {
  const { service, cwd } = await makeService()
  const stores = service.storesFor(cwd)
  const created = await stores.assets.create({ name: 'Hello', definition: definition('asset') })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'hello', revision: 1 })

  await assert.rejects(service.setNodeParams({ cwd, key: 'hello', nodeId: 'ghost', params: {} }), (error) => error.code === 'node-missing')
  await assert.rejects(service.setNodeParams({ cwd, key: 'hello', nodeId: 'greet', params: [] }), (error) => error.code === 'params-invalid')
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

test('waitFor stops as soon as a run needs a human', async () => {
  const calls = []
  const { service } = await makeService(calls)
  service.engine = {
    stop: () => {},
    request: async (method) => {
      calls.push({ method })
      return { runId: 'run-1', status: 'waiting_human', pendingTasks: [{ taskId: 'task-1' }] }
    },
  }

  const status = await service.waitFor('run-1', 5000)

  assert.equal(status.status, 'waiting_human')
  assert.equal(calls.length, 1)
})

test('submitTask forwards the task id, payload, and optional revision', async () => {
  const calls = []
  const { service } = await makeService(calls)
  const engine = {
    ensureStarted: async () => ({}),
    stop: () => {},
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'task/submit') return { taskId: params.taskId, runId: 'run-1', status: 'running', revision: 2 }
      return {}
    },
  }
  service.engine = engine

  const submitted = await service.submitTask({ taskId: 'task-9', payload: { note: 'ok' } })
  await service.submitTask({ taskId: 'task-9', payload: { note: 'ok' }, revision: 2 })

  assert.equal(submitted.status, 'running')
  assert.deepEqual(calls[0], { method: 'task/submit', params: { taskId: 'task-9', payload: { note: 'ok' } } })
  assert.equal(calls[1].params.revision, 2)
})

test('tasks asks the engine for one run', async () => {
  const calls = []
  const { service } = await makeService(calls)
  service.engine = { stop: () => {}, request: async (method, params) => ({ method, params, tasks: [] }) }

  const result = await service.tasks('run-1')

  assert.deepEqual(result.params, { runId: 'run-1' })
  assert.deepEqual(result.tasks, [])
})
