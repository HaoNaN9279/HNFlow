/**
 * The resident viewer: its command, and the state files it reads.
 *
 * The page must keep working with no HNFlow session open, and it must never
 * start a second engine; both properties are pinned here.
 */

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createViewerCommand, VIEWER_OPS } from '../lib/commands.js'
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

test('the viewer command answers only `ui`, and only the read-only ops', async () => {
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
    const bad = await command.handler({ rawInput: 'run smoke' })
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /usage: \/hnflow ui/u)

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
