/**
 * `/workflow`: parsing, routing, and the commands that never reach the model.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { USAGE, createWorkflowCommand, formatOverrideDiff, parseInputs, tokenize } from '../lib/commands.js'

/**
 * Build the command over a scripted service.
 * @param {Record<string, any>} overrides - service methods to replace.
 * @returns {{handler: Function, calls: Record<string, any>[]}} command and call log.
 */
function makeCommand(overrides = {}) {
  /** @type {Record<string, any>[]} */
  const calls = []
  const base = {
    listWorkflows: async () => [{ alias: 'publish', assetId: 'wf-1', description: '发布', pinnedRevision: 3, currentRevision: 3, hasOverride: false, drift: false, enabled: true, missing: false }],
    startRun: async (input) => {
      calls.push({ method: 'startRun', input })
      return { runId: 'run-1', status: 'queued', resolved: { source: 'ref', revision: 3 } }
    },
    waitFor: async () => ({ runId: 'run-1', status: 'succeeded', error: null, nodes: [], result: { in: 'ok' } }),
    status: async () => ({ runId: 'run-1', status: 'running', error: null, nodes: [], result: null }),
    cancel: async () => ({ runId: 'run-1', status: 'running', cancelled: true }),
    resume: async () => ({ runId: 'run-1', status: 'running' }),
    tasks: async () => ({ tasks: [{ taskId: 'task-9', runId: 'run-1', nodeId: 'approve', kind: 'task', description: 'confirm', outputSpec: { ports: [{ name: 'note', type: 'data', required: true }] } }] }),
    submitTask: async (input) => ({ taskId: input.taskId, runId: 'run-1', status: 'running', revision: 2 }),
    listAssets: async () => [{ id: 'wf-1', name: '发布', revision: 3 }],
    resolve: async () => ({ assetId: 'wf-1', source: 'override', revision: 3, currentRevision: 3 }),
    resetOverride: async () => ({ removed: true, assetId: 'wf-1' }),
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
  const command = createWorkflowCommand({ service: base, cwdOf: () => '/ws' })
  return { handler: command.handler, calls }
}

test('tokenize honours quotes and collapses whitespace', () => {
  assert.deepEqual(tokenize('  run "publish flow" a=1 '), ['run', 'publish flow', 'a=1'])
  assert.deepEqual(tokenize(''), [])
})

test('parseInputs JSON-decodes values with a string fallback', () => {
  assert.deepEqual(parseInputs(['target=staging', 'count=3', 'flag=true', 'name']), {
    input: { target: 'staging', count: 3, flag: true },
    rest: ['name'],
  })
})

test('bare /workflow lists the workspace refs', async () => {
  const { handler } = makeCommand()
  const result = await handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /- publish \(wf-1/u)
})

test('run passes typed inputs and waits for the run', async () => {
  const { handler, calls } = makeCommand()
  const result = await handler({ rawInput: 'run publish target=staging count=2' })

  assert.equal(result.kind, 'success')
  assert.deepEqual(calls[0].input, { cwd: '/ws', key: 'publish', inputs: { target: 'staging', count: 2 } })
  assert.match(result.text, /run run-1: succeeded/u)
  assert.match(result.text, /source: ref r3/u)
})

test('missing arguments come back as usage errors, not exceptions', async () => {
  const { handler } = makeCommand()
  const run = await handler({ rawInput: 'run' })
  assert.equal(run.kind, 'error')
  assert.match(run.text, /workflow-required/u)

  const unknown = await handler({ rawInput: 'nope' })
  assert.match(unknown.text, /unknown-subcommand/u)
  assert.match(unknown.text, /\/workflow — list/u)
})

test('a coded service failure keeps its code', async () => {
  const { handler } = makeCommand({
    status: async () => {
      const error = new Error('no run named run-404')
      error.code = 'unknown-run'
      throw error
    },
  })
  const result = await handler({ rawInput: 'status run-404' })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'workflow: unknown-run: no run named run-404')
})

test('ref add pins the asset revision by default and validates --pin', async () => {
  const { handler } = makeCommand()
  const added = await handler({ rawInput: 'ref add wf-1 --alias publish' })
  assert.equal(added.kind, 'success')
  assert.match(added.text, /at r3 as publish/u)

  const bad = await handler({ rawInput: 'ref add wf-1 --pin nope' })
  assert.match(bad.text, /invalid-pin/u)
})

test('override diff and reset stay inside the workspace', async () => {
  const { handler } = makeCommand()
  const diff = await handler({ rawInput: 'override diff publish' })
  assert.equal(diff.kind, 'success')
  assert.match(diff.text, /override for wf-1 \(base r2\), 1 change\(s\)/u)
  assert.match(diff.text, /- a: 1 → 2/u)

  const reset = await handler({ rawInput: 'override reset publish' })
  assert.match(reset.text, /dropped the override for publish/u)
})

test('the diff summary reports an unchanged override clearly', () => {
  const text = formatOverrideDiff({ assetId: 'wf-1', baseRevision: 1, definition: { a: 1 } }, { a: 1 })
  assert.match(text, /no difference from the asset definition/u)
})

test('help prints the full command list', async () => {
  const { handler } = makeCommand()
  const result = await handler({ rawInput: 'help' })
  assert.equal(result.text, USAGE)
})

test('tasks lists pending human work', async () => {
  const { handler } = makeCommand()
  const result = await handler({ rawInput: 'tasks run-1' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /- task-9 \(run run-1, node approve, task\) fields: note:data!/u)
})

test('resume continues an interrupted run', async () => {
  const { handler } = makeCommand()
  const result = await handler({ rawInput: 'resume run-1' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^resumed run-1/u)
})

test('submit answers a task and waits for the run', async () => {
  const { handler } = makeCommand()
  const result = await handler({ rawInput: 'submit task-9 note=ok' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^submitted task-9/u)

  const missing = await handler({ rawInput: 'submit' })
  assert.match(missing.text, /task-id-required/u)
})
