/**
 * v0.8 behaviour with the real orchestrator over fake seams: retry history in
 * the brief, extra node kinds, the run budget, trigger-driven starts and the
 * channel fallback for gates.
 */

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { fakeRunner, gateFlow, makeService, seedWorkspace } from './helpers.js'

/**
 * Flatten a brief into text for assertions.
 * @param {unknown} prompt - prompt handed to the runner.
 * @returns {string} text.
 */
function promptText(prompt) {
  return Array.isArray(prompt) ? prompt.map((part) => String(part?.text ?? '')).join('\n') : String(prompt ?? '')
}

/**
 * Build a service over a seeded workspace.
 * @param {Record<string, any>} definition - flow.
 * @param {{script?: Record<string, any[]>, runner?: Record<string, any>, config?: Record<string, any>, questions?: Record<string, any>, now?: () => Date}} [options] - seams.
 * @returns {Promise<{service: Record<string, any>, seeded: Record<string, any>}>} service and paths.
 */
async function setup(definition, options = {}) {
  const seeded = await seedWorkspace(definition)
  const service = await makeService({
    script: options.script ?? {},
    runner: options.runner,
    questions: options.questions,
    now: options.now,
    config: { libraryRoot: seeded.library, ...(options.config ?? {}) },
  })
  return { service, seeded }
}

/**
 * A flow with a custom (plugin-registered) node kind feeding a gate.
 * @returns {Record<string, any>} definition.
 */
function kindFlow() {
  return {
    schemaVersion: 2,
    flow: { id: 'fl-kind', name: '扩展节点流程' },
    input: { type: 'object', properties: {}, additionalProperties: true },
    nodes: [
      {
        id: 'stamp',
        type: 'stamp',
        title: '时间戳',
        output: { type: 'object', required: ['at'], properties: { at: { type: 'string' } }, additionalProperties: false },
      },
      { id: 'approve', type: 'gate', title: '确认' },
    ],
    edges: [{ id: 'e1', from: 'stamp', to: 'approve', when: { kind: 'status', is: 'done' } }],
  }
}

test('a retried node sees the previous failure in its brief', async () => {
  const runner = fakeRunner({
    draft: [Object.assign(new Error('the worker crashed'), { code: 'node-spawn-failed' }), { status: 'done', output: { points: ['a'] } }],
  })
  const { service, seeded } = await setup(gateFlow(), { runner })
  try {
    const started = await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'hi' } })
    const run = await started.settled
    assert.equal(run.status, 'waiting_human')
    const calls = runner.calls.filter((call) => call.nodeId === 'draft')
    assert.equal(calls.length, 2)
    assert.equal(promptText(calls[0].prompt).includes('上一轮失败记录'), false)
    const retried = promptText(calls[1].prompt)
    assert.match(retried, /上一轮失败记录/u)
    assert.match(retried, /the worker crashed/u)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a registered node kind runs deterministically and its output is checked', async () => {
  const { service, seeded } = await setup(kindFlow())
  try {
    service.registerNodeKind({ id: 'stamp', title: '时间戳', run: async () => ({ status: 'done', output: { at: '2026-01-05T00:00:00.000Z' } }) })
    assert.ok(service.nodeKinds().includes('stamp'))
    const started = await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })
    const run = await started.settled
    assert.equal(run.status, 'waiting_human')
    assert.equal(run.nodes.stamp.status, 'done')
    assert.equal(run.nodes.stamp.output.at, '2026-01-05T00:00:00.000Z')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a kind that violates its declared output fails the node', async () => {
  const { service, seeded } = await setup(kindFlow())
  try {
    service.registerNodeKind({ id: 'stamp', run: async () => ({ status: 'done', output: { nope: true } }) })
    const started = await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })
    const run = await started.settled
    assert.equal(run.status, 'failed')
    assert.equal(run.nodes.stamp.diagnostic.code, 'contract-unsatisfied')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('the run budget fails a run that outlives it', async () => {
  let clock = new Date('2026-01-05T10:00:00.000Z')
  const now = () => clock
  const runner = {
    available: () => true,
    spawn: async () => {
      clock = new Date(clock.getTime() + 120_000)
      return {
        childId: 'child-draft',
        result: Promise.resolve({ childId: 'child-draft', stopReason: 'completed', output: [], structured: { status: 'done', output: { points: ['a'] } } }),
        dispose: async () => {},
      }
    },
  }
  const { service, seeded } = await setup(gateFlow(), { runner, now, config: { runBudgetMs: 60_000 } })
  try {
    const started = await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'hi' } })
    const run = await started.settled
    assert.equal(run.status, 'failed')
    assert.equal(run.error.code, 'run-budget-exceeded')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a failing question card falls back to the inbox', async () => {
  const questions = {
    ask: async () => {
      throw new Error('no interactive host')
    },
  }
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: [] } }] }, questions })
  try {
    const started = await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'hi' } })
    const run = await started.settled
    assert.equal(run.status, 'waiting_human')
    const [item] = await service.inbox()
    assert.equal(item.kind, 'gate')
    assert.equal(item.stage, 'decide')
    assert.match(item.summary, /裁决/u)
    const pending = run.pending[0]
    assert.equal(pending.askedVia, 'inbox')
    assert.match(String(pending.askError ?? ''), /no interactive host/u)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a succeeded run triggers the next flow through the outbox', async () => {
  const definition = gateFlow()
  const { service, seeded } = await setup(definition, { script: { draft: [{ status: 'done', output: { points: ['a'] } }] } })
  try {
    await mkdir(path.join(seeded.workspace, '.hnflow'), { recursive: true })
    await writeFile(
      path.join(seeded.workspace, '.hnflow', 'triggers.json'),
      JSON.stringify({ triggers: [{ id: 'after', source: 'run-completed', after: definition.flow.id, flow: 'demo', input: { brief: 'next' } }] }, null, 2),
      'utf8',
    )
    await service.snapshot([{ id: seeded.workspace, path: seeded.workspace, name: 'ws' }])
    const started = await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'hi' } })
    const run = await started.settled
    assert.equal(run.status, 'waiting_human')
    const pending = run.pending[0]
    const decided = await service.decide({ runId: run.runId, gateId: pending.id, decision: 'approved', reason: 'ok', revision: pending.revision })
    await decided.settled
    const first = await service.getRun(run.runId)
    assert.equal(first.status, 'succeeded')
    const report = await service.pass()
    assert.equal(report.triggers, 1)
    const runs = await service.listRuns({ limit: 10 })
    assert.equal(runs.length, 2)
    const chained = runs.find((entry) => entry.runId !== run.runId)
    assert.equal(chained.trigger.source, 'run-completed')
    assert.equal(chained.status, 'waiting_human')
    const again = await service.pass()
    assert.equal(again.triggers, 0)
    assert.equal((await service.listRuns({ limit: 10 })).length, 2)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('the pass starts a run from .hnflow/triggers.json once per minute', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const stateDir = path.join(seeded.root, 'state')
  const service = await makeService({
    script: { draft: [{ status: 'done', output: { points: ['a'] } }] },
    config: { libraryRoot: seeded.library, stateDir },
  })
  try {
    await mkdir(path.join(seeded.workspace, '.hnflow'), { recursive: true })
    await writeFile(
      path.join(seeded.workspace, '.hnflow', 'triggers.json'),
      JSON.stringify({ triggers: [{ id: 'tick', source: 'cron', cron: '* * * * *', flow: 'demo', input: { brief: 'scheduled' } }] }, null, 2),
      'utf8',
    )
    await service.snapshot([{ id: seeded.workspace, path: seeded.workspace, name: 'ws' }])
    const first = await service.pass()
    assert.equal(first.triggers, 1)
    const runs = await service.listRuns({ limit: 10 })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].trigger.source, 'cron')
    const listing = await service.triggers()
    assert.equal(listing.triggers.length, 1)
    assert.equal(typeof listing.triggers[0].lastFiredAt, 'string')
    const second = await service.pass()
    assert.equal(second.triggers, 0)
    assert.equal((await service.listRuns({ limit: 10 })).length, 1)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
