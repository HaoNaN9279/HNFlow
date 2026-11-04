/**
 * `/workflow ui` — the browser surfaces' channel.
 *
 * The point of these tests is the two properties the panel depends on: the
 * payload survives Windows paths and CJK, and the command runs even when the
 * invocation has no agent (a global page belongs to no session).
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createWorkflowCommand, extractSessionOption } from '../lib/commands.js'
import { decodePayload, dispatchUi, encodePayload, UiError } from '../lib/ui.js'

/**
 * A scratch home for one test.
 * @param {string} name - unique suffix.
 * @returns {Promise<string>} absolute directory (created).
 */
async function scratchHome(name) {
  const dir = path.join(process.cwd(), 'temp', `ui-test-${name}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

test('the payload round-trips Windows paths and CJK', () => {
  const payload = { workspace: 'D:\\workspace\\HNFlow', key: '发布-公告', nested: { n: 1 } }
  const encoded = encodePayload(payload)

  assert.equal(encoded.includes(' '), false)
  assert.equal(encoded.includes('\\'), false)
  assert.deepEqual(decodePayload(encoded), payload)
})

test('an absent payload decodes to an empty object', () => {
  assert.deepEqual(decodePayload(undefined), {})
  assert.deepEqual(decodePayload(''), {})
})

test('a malformed payload is rejected with a stable code', () => {
  assert.throws(() => decodePayload(Buffer.from('not json').toString('base64url')), (error) => error instanceof UiError && error.code === 'ui-unreadable')
  assert.throws(() => decodePayload(Buffer.from('[1,2]').toString('base64url')), (error) => error.code === 'ui-unreadable')
})

test('ping appends one line to the probe log', async () => {
  const home = await scratchHome('ping')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const answer = JSON.parse(await dispatchUi(['ping', encodePayload({ surface: 'S1', detail: 'main panel' })]))
    assert.equal(answer.ok, true)
    const log = await readFile(path.join(home, 'hnflow', 'spike.log'), 'utf8')
    assert.match(log, /S1 main panel/u)
    assert.equal(log.trim().split('\n').length, 1)
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('an unknown op and a missing op both fail with ui-op', async () => {
  await assert.rejects(dispatchUi([]), (error) => error.code === 'ui-op')
  await assert.rejects(dispatchUi(['nope']), (error) => error.code === 'ui-op')
})

test('the ui branch runs without a session, other commands still need one', async () => {
  const home = await scratchHome('command')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const command = createWorkflowCommand({ service: {}, cwdOf: () => null })

    const ok = await command.handler({ rawInput: `ui ping ${encodePayload({ surface: 'S2' })}` })
    assert.equal(ok.kind, 'success')

    const blocked = await command.handler({ rawInput: 'list' })
    assert.equal(blocked.kind, 'error')
    assert.match(blocked.text, /no workspace directory/u)
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

/** A stand-in service that records what the UI ops ask for. */
function fakeService() {
  const calls = { workflows: [], assets: 0, resolved: [], read: [] }
  return {
    calls,
    async listWorkflows(cwd) {
      calls.workflows.push(cwd)
      if (cwd.endsWith('broken')) {
        const error = new Error('cannot read refs')
        error.code = 'refs-unreadable'
        throw error
      }
      return [{ alias: 'publish', assetId: 'wf-1', hasOverride: false }]
    },
    async listAssets() {
      calls.assets += 1
      return [{ id: 'wf-1', name: 'publish', revision: 2 }]
    },
    async resolve(workspace, key) {
      calls.resolved.push([workspace, key])
      return { key, alias: 'publish', assetId: 'wf-1', assetName: 'publish', definition: { nodes: [], edges: [] }, source: 'ref', revision: 1, currentRevision: 2, baseRevision: 1, drift: false, hash: 'h1' }
    },
    async readAsset(assetId, revision) {
      calls.read.push([assetId, revision])
      return { asset: { id: assetId, name: 'publish', revision: 2 }, definition: { nodes: [{ id: 'start' }], edges: [] }, hash: 'h2' }
    },
    async monitor() {
      return { runs: [{ runId: 'run-1', status: 'running' }], tasks: [{ taskId: 'task-1', runId: 'run-1' }] }
    },
  }
}

test('tree answers every workspace plus the library, and one bad workspace does not abort', async () => {
  const service = fakeService()
  const answer = JSON.parse(
    await dispatchUi(['tree', encodePayload({
      workspaces: [
        { id: 'w1', name: 'HNFlow', path: 'D:\\workspace\\HNFlow' },
        { id: 'w2', name: 'broken', path: 'D:\\tmp\\broken' },
        { id: 'w3', path: '' },
      ],
    })], { service }),
  )

  assert.equal(answer.workspaces.length, 2)
  assert.deepEqual(answer.workspaces[0].workflows.map((entry) => entry.alias), ['publish'])
  assert.equal(answer.workspaces[1].error, 'refs-unreadable')
  assert.deepEqual(answer.workspaces[1].workflows, [])
  assert.equal(answer.assets.length, 1)
  assert.deepEqual(service.calls.workflows, ['D:\\workspace\\HNFlow', 'D:\\tmp\\broken'])
})

test('canvas resolves the selected workflow and needs both arguments', async () => {
  const service = fakeService()
  const answer = JSON.parse(await dispatchUi(['canvas', encodePayload({ workspace: 'D:\\w', key: 'publish' })], { service }))

  assert.equal(answer.key, 'publish')
  assert.equal(answer.assetId, 'wf-1')
  assert.equal(answer.source, 'ref')
  assert.deepEqual(answer.definition, { nodes: [], edges: [] })
  assert.deepEqual(service.calls.resolved, [['D:\\w', 'publish']])

  await assert.rejects(dispatchUi(['canvas', encodePayload({ workspace: 'D:\\w' })], { service }), (error) => error.code === 'ui-args')
})

test('assetCanvas reads the library asset, optionally at a revision', async () => {
  const service = fakeService()

  const latest = JSON.parse(await dispatchUi(['assetCanvas', encodePayload({ assetId: 'wf-1' })], { service }))
  assert.equal(latest.source, 'asset')
  assert.equal(latest.revision, 2)
  assert.equal(latest.currentRevision, 2)

  const pinned = JSON.parse(await dispatchUi(['assetCanvas', encodePayload({ assetId: 'wf-1', revision: 1 })], { service }))
  assert.equal(pinned.source, 'revision')
  assert.equal(pinned.revision, 1)
  assert.equal(pinned.currentRevision, 2)
  assert.deepEqual(service.calls.read, [['wf-1', null], ['wf-1', 1]])

  await assert.rejects(dispatchUi(['assetCanvas', encodePayload({})], { service }), (error) => error.code === 'ui-args')
})

test('monitor returns the service payload verbatim', async () => {
  const service = fakeService()
  const answer = JSON.parse(await dispatchUi(['monitor', encodePayload({})], { service }))
  assert.equal(answer.runs[0].runId, 'run-1')
  assert.equal(answer.tasks[0].taskId, 'task-1')
})

test('a page op without a service says so', async () => {
  await assert.rejects(dispatchUi(['tree', encodePayload({ workspaces: [] })]), (error) => error.code === 'ui-service')
})

test('--session is lifted out of the run arguments', () => {
  assert.deepEqual(extractSessionOption(['publish', 'out=1']), { rest: ['publish', 'out=1'], sessionId: null })
  assert.deepEqual(extractSessionOption(['publish', '--session', 's-1', 'out=1']), { rest: ['publish', 'out=1'], sessionId: 's-1' })
  assert.deepEqual(extractSessionOption(['--session=s-2', 'publish']), { rest: ['publish'], sessionId: 's-2' })
  assert.deepEqual(extractSessionOption(['publish', '--session']), { rest: ['publish'], sessionId: null })
})

test('wait returns as soon as an unseen task exists', async () => {
  const service = {
    async monitor() {
      return { runs: [{ runId: 'run-1' }], tasks: [{ taskId: 'task-1' }, { taskId: 'task-2' }] }
    },
  }

  const fresh = JSON.parse(await dispatchUi(['wait', encodePayload({ known: ['task-1'], timeoutMs: 2000 })], { service }))
  assert.equal(fresh.changed, true)
  assert.equal(fresh.tasks.length, 2)

  const idle = JSON.parse(await dispatchUi(['wait', encodePayload({ known: ['task-1', 'task-2'], timeoutMs: 1000 })], { service }))
  assert.equal(idle.changed, false)
  assert.equal(idle.runs.length, 1)
})
