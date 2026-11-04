/**
 * The `hnflow` tool: explicit naming, readable failures, start-only semantics.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkflowTool, formatRunStatus, formatWorkflowList } from '../lib/tools.js'
/** A `defineTool` stand-in that keeps the spec addressable. */
const defineTool = (spec) => spec

/**
 * A service stand-in with scripted responses.
 * @param {Partial<Record<string, Function>>} overrides - per-method behaviour.
 * @returns {Record<string, any>} fake service.
 */
function fakeService(overrides = {}) {
  return {
    listWorkflows: async () => [
      { alias: 'publish', assetId: 'wf-1', description: '发布流程', pinnedRevision: 3, currentRevision: 4, hasOverride: true, drift: true, enabled: true, missing: false },
      { alias: '', assetId: 'wf-2', description: '', pinnedRevision: null, currentRevision: 1, hasOverride: false, drift: false, enabled: true, missing: false },
    ],
    resolve: async (_cwd, key) => ({ key, alias: key, assetId: 'wf-1', assetName: '发布流程', definition: { nodes: [] }, source: 'ref', revision: 3, currentRevision: 4, drift: true }),
    startRun: async () => ({ runId: 'run-1', status: 'queued', startedAt: 'now', resolved: { source: 'ref', revision: 3 } }),
    status: async () => ({ runId: 'run-1', status: 'succeeded', error: null, nodes: [{ nodeId: 'greet', status: 'succeeded' }], result: { in: 'hello' } }),
    cancel: async () => ({ runId: 'run-1', status: 'running', cancelled: true }),
    resume: async () => ({ runId: 'run-1', status: 'running' }),
    tasks: async () => ({ tasks: [] }),
    submitTask: async (input) => ({ taskId: input.taskId, runId: 'run-1', status: 'running', revision: 2 }),
    listAssets: async () => [{ id: 'wf-1', name: '发布流程', revision: 4, description: '发布' }],
    ...overrides,
  }
}

/**
 * Build the tool over a fake service.
 * @param {Record<string, any>} service - fake service.
 * @returns {Record<string, any>} tool definition.
 */
function makeTool(service) {
  return createWorkflowTool({ defineTool, service, cwdOf: () => '/ws' })
}

test('the tool name avoids the built-in workflow tool', () => {
  const tool = makeTool(fakeService())
  assert.equal(tool.name, 'hnflow')
  assert.equal(tool.parameters.action.enum.includes('run'), true)
})

test('list renders alias, revision, and flags', async () => {
  const text = await makeTool(fakeService()).execute({ action: 'list' }, {})
  assert.match(text, /- publish \(wf-1, pinned r3 of r4\) \[override, drift\]: 发布流程/u)
  assert.match(text, /- wf-2 \(wf-2, r1\)/u)
})

test('run requires an explicit workflow name', async () => {
  const text = await makeTool(fakeService()).execute({ action: 'run' }, {})
  assert.match(text, /^error workflow-required:/u)
})

test('run starts the workflow and returns without following it', async () => {
  const text = await makeTool(fakeService()).execute({ action: 'run', workflow: 'publish', input: { target: 'staging' } }, {})

  assert.match(text, /^started run-1 \(publish, ref r3\), status queued/u)
  assert.match(text, /continues without this session/u)
  // A start result never carries a terminal status: nothing waited.
  assert.equal(/succeeded|failed/.test(text), false)
})

test('run hands the session id to the engine for the monitor', async () => {
  /** @type {Record<string, any>[]} */
  const started = []
  const service = fakeService({
    startRun: async (input) => {
      started.push(input)
      return { runId: 'run-1', status: 'queued', resolved: { source: 'ref', revision: 3 } }
    },
  })
  await makeTool(service).execute({ action: 'run', workflow: 'publish' }, { agent: { session: { id: 'session-7' } } })

  assert.equal(started[0].sessionId, 'session-7')
})

test('service failures surface as coded text, not exceptions', async () => {
  const service = fakeService({
    resolve: async () => {
      const error = new Error('no workflow named publish in this workspace')
      error.code = 'ref-missing'
      throw error
    },
  })
  const text = await makeTool(service).execute({ action: 'get', workflow: 'publish' }, {})
  assert.equal(text, 'error ref-missing: no workflow named publish in this workspace')
})

test('a session without a workspace says so', async () => {
  const tool = createWorkflowTool({ defineTool, service: fakeService(), cwdOf: () => null })
  assert.match(await tool.execute({ action: 'list' }, {}), /workspace-unavailable/u)
})

test('run status text omits empty sections', () => {
  assert.equal(formatRunStatus({ runId: 'run-1', status: 'failed', error: 'boom', nodes: [], result: null }), 'run run-1: failed\nerror: boom')
})

test('run status shows the human task it is waiting on', () => {
  const text = formatRunStatus({
    runId: 'run-1',
    status: 'waiting_human',
    pendingTasks: [{ taskId: 'task-9', kind: 'task', nodeId: 'approve', description: 'confirm the release' }],
  })
  assert.match(text, /waiting on task task-9 \(task node approve\): confirm the release/u)
})

test('task_list renders fields and the empty case', async () => {
  const empty = await makeTool(fakeService({ tasks: async () => ({ tasks: [] }) })).execute({ action: 'task_list', run_id: 'run-1' }, {})
  assert.equal(empty, 'No pending human tasks.')

  const service = fakeService({
    tasks: async () => ({
      tasks: [{ taskId: 'task-9', runId: 'run-1', nodeId: 'approve', kind: 'task', description: 'confirm', outputSpec: { ports: [{ name: 'note', type: 'data', required: true }] } }],
    }),
  })
  const text = await makeTool(service).execute({ action: 'task_list', run_id: 'run-1' }, {})
  assert.match(text, /- task-9 \(run run-1, node approve, task\) fields: note:data!/u)
})

test('events renders a node timeline', async () => {
  const service = fakeService({
    events: async () => ({
      events: [
        { seq: 1, at: '2026-11-03T12:00:00.000Z', type: 'run/started', nodeId: null, data: {} },
        { seq: 2, at: '2026-11-03T12:00:00.100Z', type: 'node/completed', nodeId: 'greet', data: { output: { out: 'hi' } } },
        { seq: 3, at: '2026-11-03T12:00:00.200Z', type: 'run/succeeded', nodeId: null, data: { status: 'succeeded' } },
      ],
    }),
  })
  const text = await makeTool(service).execute({ action: 'events', run_id: 'run-1' }, {})

  assert.match(text, /  1 {2}12:00:00.000 {2}run\/started/u)
  assert.match(text, /  2 {2}12:00:00.100 {2}node\/completed greet/u)
  assert.match(text, /"out":"hi"/u)
})

test('an empty timeline says so', async () => {
  const service = fakeService({ events: async () => ({ events: [] }) })
  assert.equal(await makeTool(service).execute({ action: 'events', run_id: 'run-1' }, {}), 'no events recorded for this run')
})

test('resume continues an interrupted run without waiting for it', async () => {
  const service = fakeService({ resume: async () => ({ runId: 'run-1', status: 'running' }) })
  const text = await makeTool(service).execute({ action: 'resume', run_id: 'run-1' }, {})
  assert.match(text, /^resumed run-1 \(status running\)/u)
  assert.match(text, /continues without this session/u)
})

test('task_submit needs an id, then submits without waiting', async () => {
  const bare = await makeTool(fakeService()).execute({ action: 'task_submit' }, {})
  assert.match(bare, /^error task-id-required:/u)

  /** @type {Record<string, any>[]} */
  const submitted = []
  const service = fakeService({
    submitTask: async (input) => {
      submitted.push(input)
      return { taskId: input.taskId, runId: 'run-1', status: 'running', revision: 2 }
    },
  })
  const text = await makeTool(service).execute({ action: 'task_submit', task_id: 'task-9', input: { note: 'lgtm' }, revision: 2 }, {})

  assert.deepEqual(submitted[0], { taskId: 'task-9', payload: { note: 'lgtm' }, revision: 2 })
  assert.match(text, /^submitted task-9; run run-1 continues/u)
})

test('an empty catalogue has a usable message', () => {
  assert.equal(formatWorkflowList([]), 'This workspace references no HNFlow workflows.')
})
