/**
 * The resident viewer: its command, the state files it reads, and the library
 * channel `/hnflow` carries for the page.
 *
 * The page must keep working with no HNFlow session open, it must never start a
 * second engine, and it must never start a run; all three are pinned here.
 */

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createViewerCommand, formatOverrideDiff, VIEWER_OPS } from '../lib/commands.js'
import { fileMonitor, shapeMonitor, stateDirectory } from '../lib/state.js'

/**
 * A scratch state directory.
 * @param {string} name - unique suffix.
 * @returns {Promise<string>} absolute directory (created).
 */
async function scratchState(name) {
  const directory = path.join(process.cwd(), 'temp', `state-${name}`)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  return directory
}

test('file records and engine records shape into the same monitor payload', () => {
  const fromEngine = shapeMonitor(
    [{ runId: 'run-1', status: 'waiting_human', startedAt: 't0', endedAt: null, updatedAt: 't0', metadata: { workspace: 'D:/w', sessionId: 's-1', workflowAlias: 'smoke' }, nodes: [{ nodeId: 'greet' }, { nodeId: 'confirm' }] }],
    [{ taskId: 'task-1', runId: 'run-1', nodeId: 'confirm', kind: 'task', description: '确认', createdAt: 't1', updatedAt: 't1', status: 'pending' }],
  )
  const fromFiles = shapeMonitor(
    [{ runId: 'run-1', status: 'waiting_human', started_at: 't0', ended_at: null, metadata: { workspace: 'D:/w', sessionId: 's-1', workflowAlias: 'smoke' }, nodes: { greet: {}, confirm: {} } }],
    [{ id: 'task-1', workflow_run_id: 'run-1', node_id: 'confirm', kind: 'task', description: '确认', created_at: 't1', updated_at: 't1', status: 'pending' }],
  )

  assert.deepEqual(fromFiles.runs[0].runId, fromEngine.runs[0].runId)
  assert.deepEqual(fromFiles.runs[0].node, 'confirm')
  assert.deepEqual(fromFiles.runs[0].workspace, 'D:/w')
  assert.deepEqual(fromFiles.tasks[0].taskId, 'task-1')
  assert.deepEqual(fromFiles.tasks[0].workflow, 'smoke')
  assert.equal(fromEngine.runs[0].node, 'confirm')
})

test('submitted tasks are not listed and a missing file is empty', async () => {
  const directory = await scratchState('sparse')
  try {
    const empty = await fileMonitor({ stateDir: directory })
    assert.deepEqual(empty, { runs: [], tasks: [] })

    await writeFile(path.join(directory, 'runs.json'), '[{"runId":"r1","status":"succeeded","metadata":{}}]', 'utf8')
    await writeFile(path.join(directory, 'tasks.json'), '[{"id":"t1","workflow_run_id":"r1","status":"submitted"},{"id":"t2","workflow_run_id":"r1","status":"pending"}]', 'utf8')
    const payload = await fileMonitor({ stateDir: directory })
    assert.deepEqual(
      payload.tasks.map((task) => task.taskId),
      ['t2'],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a half-written state file is ignored instead of throwing', async () => {
  const directory = await scratchState('broken')
  try {
    await writeFile(path.join(directory, 'runs.json'), '[{"runId": "r1"', 'utf8')
    const payload = await fileMonitor({ stateDir: directory })
    assert.deepEqual(payload, { runs: [], tasks: [] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the state directory follows the config and the DSH home', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = path.join(process.cwd(), 'temp', 'home-probe')
    assert.equal(stateDirectory({}), path.join(process.cwd(), 'temp', 'home-probe', 'hnflow', 'state'))
    assert.equal(stateDirectory({ stateDir: './custom' }), path.resolve('custom'))
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('the viewer command answers `ui` with the read-only ops only', async () => {
  const directory = await scratchState('viewer')
  try {
    const service = {
      async fileMonitor() {
        return { runs: [], tasks: [] }
      },
      assertNotCalled() {
        throw new Error('the viewer must not touch the engine')
      },
      async listRuns() {
        return this.assertNotCalled()
      },
    }
    const command = createViewerCommand({ service })

    assert.equal(command.name, 'hnflow')

    const ok = await command.handler({ rawInput: 'ui monitor e30' })
    assert.equal(ok.kind, 'success')
    assert.equal(JSON.parse(ok.text).tasks.length, 0)

    // `run` is a mode capability, not a viewer one.
    assert.equal(VIEWER_OPS.has('monitor'), true)
    assert.equal(VIEWER_OPS.has('run'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * A service stand-in for the library channel.
 * @param {Record<string, any>} [overrides] - methods to replace.
 * @returns {Record<string, any>} fake service.
 */
function fakeService(overrides = {}) {
  return {
    listWorkflows: async () => [
      { alias: 'publish', assetId: 'wf-1', description: '发布', pinnedRevision: 3, currentRevision: 3, hasOverride: false, drift: false, enabled: true, missing: false },
    ],
    listAssets: async () => [{ id: 'wf-1', name: '发布', revision: 3 }],
    createAsset: async (input) => ({ assetId: 'wf-new', name: input.name, revision: 1 }),
    importAsset: async (input) => ({ assetId: 'wf-imp', name: 'Imported', revision: 1, source: input.path }),
    deleteAsset: async (input) => ({ assetId: input.assetId, path: 'x', hadOverride: true }),
    repinRef: async (input) => ({ key: input.key, assetId: 'wf-1', revision: input.revision ?? 4, currentRevision: 4 }),
    resolve: async (_cwd, key) => ({ key, assetId: 'wf-1', source: 'override', revision: 3, currentRevision: 3 }),
    saveAsset: async (input) => ({ assetId: 'wf-1', name: '发布流程', previousRevision: 3, revision: 4, key: input.key }),
    resetOverride: async () => ({ removed: true, assetId: 'wf-1' }),
    setNodeParams: async (input) => ({ key: input.key, assetId: 'wf-1', nodeId: input.nodeId, baseRevision: 3 }),
    storesFor: () => ({
      workspace: {
        addRef: async (input) => ({ ...input, alias: input.alias }),
        removeRef: async () => ({ alias: 'publish', assetId: 'wf-1' }),
        readOverride: async () => ({ assetId: 'wf-1', baseRevision: 2, definition: { a: 2 } }),
      },
      assets: {
        read: async () => ({ asset: { revision: 3 }, definition: { a: 1 } }),
      },
    }),
    ...overrides,
  }
}

/**
 * Build the viewer command over a fake service.
 * @param {Record<string, any>} [overrides] - service methods to replace.
 * @returns {Function} handler bound to a session in `/ws`.
 */
function adminHandler(overrides) {
  const command = createViewerCommand({ service: fakeService(overrides), cwdOf: () => '/ws' })
  return (rawInput) => command.handler({ agent: { session: { id: 's-1' } }, rawInput })
}

test('bare /hnflow explains the channel and lists the refs', async () => {
  const result = await adminHandler()('')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\/hnflow ui <op>/u)
  assert.match(result.text, /- publish \(wf-1/u)
})

test('the library channel has no way to run a workflow', async () => {
  const handler = adminHandler()
  for (const line of ['run publish', 'submit task-9 note=x', 'status run-1', 'resume run-1']) {
    const result = await handler(line)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /unknown-subcommand/u)
  }
})

test('ref add pins the asset revision by default and validates --pin', async () => {
  const handler = adminHandler()
  const added = await handler('ref add wf-1 --alias publish')
  assert.equal(added.kind, 'success')
  assert.match(added.text, /at r3 as publish/u)

  const bad = await handler('ref add wf-1 --pin nope')
  assert.match(bad.text, /invalid-pin/u)
})

test('ref pin moves or frees a reference', async () => {
  const handler = adminHandler()

  const pinned = await handler('ref pin publish --to 4')
  assert.match(pinned.text, /publish pinned to r4 \(asset is at r4\)/u)

  const latest = await handler('ref pin publish')
  assert.match(latest.text, /publish pinned to r4/u)

  const bad = await handler('ref pin publish --to nope')
  assert.match(bad.text, /invalid-pin/u)
})

test('asset new / import / delete manage the library', async () => {
  const handler = adminHandler()

  const created = await handler('asset new "Release flow"')
  assert.equal(created.kind, 'success')
  assert.match(created.text, /created Release flow \(wf-new, r1\)/u)
  assert.match(created.text, /ref add wf-new/u)

  const imported = await handler('asset import ./flow.json --name Imported')
  assert.match(imported.text, /imported Imported as wf-imp \(r1\) from \.\/flow\.json/u)

  const deleted = await handler('asset delete wf-imp')
  assert.match(deleted.text, /deleted wf-imp \(its workspace override was removed too\)/u)

  const usage = await handler('asset new')
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /usage: \/hnflow asset new/u)
})

test('override diff and reset stay inside the workspace', async () => {
  const handler = adminHandler()
  const diff = await handler('override diff publish')
  assert.equal(diff.kind, 'success')
  assert.match(diff.text, /override for wf-1 \(base r2\), 1 change\(s\)/u)
  assert.match(diff.text, /- a: 1 → 2/u)

  const reset = await handler('override reset publish')
  assert.match(reset.text, /dropped the override for publish/u)
})

test('the diff summary reports an unchanged override clearly', () => {
  const text = formatOverrideDiff({ assetId: 'wf-1', baseRevision: 1, definition: { a: 1 } }, { a: 1 })
  assert.match(text, /no difference from the asset definition/u)
})

test('save asset is a dry run until --yes', async () => {
  const handler = adminHandler()

  const dry = await handler('save asset publish')
  assert.equal(dry.kind, 'success')
  assert.match(dry.text, /this would write publish back to wf-1: r3 → r4/u)
  assert.match(dry.text, /rerun with --yes to save/u)

  const saved = await handler('save asset publish --yes')
  assert.equal(saved.kind, 'success')
  assert.match(saved.text, /saved 发布流程 \(wf-1\) as revision 4 \(was r3\)/u)
  assert.match(saved.text, /\/hnflow ref list/u)

  const usage = await handler('save')
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /usage: \/hnflow save asset <name>/u)
})

test('node set edits one node through the raw remainder', async () => {
  /** @type {Record<string, any>[]} */
  const calls = []
  const handler = adminHandler({
    setNodeParams: async (input) => {
      calls.push(input)
      return { key: input.key, assetId: 'wf-1', nodeId: input.nodeId, baseRevision: 3 }
    },
  })

  const ok = await handler('node publish greet {"value": "a  b"}')
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /updated greet in the workspace override for publish \(base r3\)/u)
  assert.deepEqual(calls[0].params, { value: 'a  b' })

  const bad = await handler('node publish greet {nope}')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /params-invalid/u)

  const usage = await handler('node publish')
  assert.match(usage.text, /usage: \/hnflow node/u)
})
