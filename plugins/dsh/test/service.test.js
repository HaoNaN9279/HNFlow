/**
 * Orchestrator behaviour, exercised with fake seams:
 * runs, envelopes, gates, deliveries, retries, cancellation and restart.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'

import { deliveryFlow, fakeRunner, gateFlow, makeService, memoryStore, seedWorkspace } from './helpers.js'

/**
 * Start a run and wait for it to settle.
 * @param {Record<string, any>} service - orchestrator.
 * @param {string} cwd - workspace.
 * @param {Record<string, any>} [input] - run input.
 * @returns {Promise<Record<string, any>>} settled run.
 */
async function startAndWait(service, cwd, input = { brief: 'hi' }) {
  const started = await service.run({ cwd, key: 'demo', input })
  return started.settled
}

/**
 * Build a service over a seeded workspace.
 * @param {Record<string, any>} definition - flow.
 * @param {{script?: Record<string, any[]>, vibestack?: Record<string, any> | null}} [options] - seams.
 * @returns {Promise<{service: Record<string, any>, seeded: Record<string, any>}>} service and paths.
 */
async function setup(definition, options = {}) {
  const seeded = await seedWorkspace(definition)
  const service = await makeService({
    script: options.script ?? {},
    config: { libraryRoot: seeded.library },
    vibestack: options.vibestack,
    runner: options.runner,
  })
  return { service, seeded }
}

test('an agent node hands off to a gate, and approval succeeds the run', async () => {
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: ['a', 'b'] } }] } })
  try {
    const run = await startAndWait(service, seeded.workspace)
    assert.equal(run.status, 'waiting_human')
    assert.equal(run.nodes.draft.status, 'done')
    assert.deepEqual(run.nodes.draft.output, { points: ['a', 'b'] })
    const inbox = await service.inbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].kind, 'gate')

    const decided = await service.decide({ runId: run.runId, gateId: inbox[0].id, decision: 'approved', revision: inbox[0].revision })
    const settled = await decided.settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.approve.status, 'done')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('rejecting a gate fails the run with an audit entry', async () => {
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: [] } }] } })
  try {
    const run = await startAndWait(service, seeded.workspace)
    const [item] = await service.inbox()
    const settled = await (await service.decide({ runId: run.runId, gateId: item.id, decision: 'rejected', reason: 'not good' })).settled
    assert.equal(settled.status, 'failed')
    assert.equal(settled.nodes.approve.status, 'failed')
    assert.equal(settled.audit.length, 1)
    assert.equal(settled.audit[0].decision.decision, 'rejected')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a contract-violating output fails loud without a retry', async () => {
  const runner = fakeRunner({ draft: [{ status: 'done', output: { nope: true } }, { status: 'done', output: { nope: true } }] })
  const { service, seeded } = await setup(gateFlow(), { runner })
  try {
    const run = await startAndWait(service, seeded.workspace)
    assert.equal(run.status, 'failed')
    assert.equal(run.nodes.draft.diagnostic.code, 'contract-unsatisfied')
    // A contract violation is deterministic: the node is not retried.
    assert.equal(runner.calls.filter((call) => call.nodeId === 'draft').length, 1)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('needs_human opens a request and the same node continues with the delivery', async () => {
  const definition = {
    schemaVersion: 2,
    flow: { id: 'fl-human', name: '人工缺口' },
    input: { type: 'object', properties: {} },
    nodes: [
      {
        id: 'explore',
        type: 'agent',
        preset: 'hnflow',
        allowHuman: true,
        instruction: '看看需要什么',
        output: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false },
      },
    ],
    edges: [],
  }
  const script = {
    explore: [
      { status: 'needs_human', needsHuman: { reason: 'capability_gap', deliverable: { type: 'object', required: ['files'] }, whyHuman: '需要真实文件' } },
      { status: 'done', output: { answer: 'ok' } },
    ],
  }
  const { service, seeded } = await setup(definition, { script })
  try {
    const run = await startAndWait(service, seeded.workspace)
    assert.equal(run.status, 'waiting_human')
    assert.equal(run.nodes.explore.status, 'waiting')
    const [item] = await service.inbox()
    assert.equal(item.kind, 'request')
    assert.equal(item.gap.whyHuman, '需要真实文件')

    const settled = await (await service.deliver({ runId: run.runId, requestId: item.id, payload: { files: ['a'] }, revision: item.revision })).settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.explore.status, 'done')
    assert.equal(run.pending[0].gap.reason, 'capability_gap')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a needs_human report is refused unless the node allows it', async () => {
  const { service, seeded } = await setup(gateFlow(), {
    script: { draft: [{ status: 'needs_human', needsHuman: { reason: 'authority', deliverable: {}, whyHuman: 'x' } }] },
  })
  try {
    const run = await startAndWait(service, seeded.workspace)
    assert.equal(run.status, 'failed')
    assert.equal(run.nodes.draft.diagnostic.code, 'human-not-allowed')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a delivery is verified before it can be consumed', async () => {
  const { service, seeded } = await setup(deliveryFlow(), { script: { integrate: [{ status: 'done', output: { changes: ['a'] } }] } })
  try {
    const run = await startAndWait(service, seeded.workspace, {})
    assert.equal(run.status, 'waiting_human')
    const [item] = await service.inbox()
    assert.equal(item.kind, 'request')

    const rejected = service.deliver({ runId: run.runId, requestId: item.id, payload: { files: 'nope' }, revision: item.revision })
    await assert.rejects(() => rejected, (error) => error.code === 'delivery-rejected')
    assert.equal((await service.getRun(run.runId)).status, 'waiting_human')

    const settled = await (await service.deliver({ runId: run.runId, requestId: item.id, payload: { files: ['a.png'] }, revision: item.revision })).settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.accept.status, 'done')
    assert.equal(settled.nodes.integrate.status, 'done')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a judge rejection returns the delivery to the human within the budget', async () => {
  const definition = deliveryFlow()
  definition.nodes[1].checks = ['schema', 'judge']
  definition.nodes[1].judge = { preset: 'standard', criteria: '像样', model: 'strong' }
  const runner = fakeRunner({
    'accept:judge': [{ status: 'done', output: { verdict: 'reject', reasons: ['太糊'] } }, { status: 'done', output: { verdict: 'accept', reasons: ['可以'] } }],
    integrate: [{ status: 'done', output: { changes: [] } }],
  })
  const { service, seeded } = await setup(definition, { runner })
  try {
    const run = await startAndWait(service, seeded.workspace, {})
    const first = (await service.inbox())[0]
    const returned = await (await service.deliver({ runId: run.runId, requestId: first.id, payload: { files: ['a.png'] }, revision: first.revision })).settled
    assert.equal(returned.status, 'waiting_human')
    assert.equal(returned.nodes.accept.diagnostic.code, 'judge-reject')

    const second = (await service.inbox())[0]
    assert.equal(second.id, first.id)
    assert.equal(second.attempts, 1)
    const settled = await (await service.deliver({ runId: run.runId, requestId: second.id, payload: { files: ['a.png'] }, revision: second.revision })).settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.accept.output.judged, true)
    // The verify judge may pin its own layer, independent of the producer.
    const judgeCall = runner.calls.find((call) => call.nodeId === 'accept:judge')
    assert.deepEqual(judgeCall.agentOptions, { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' })
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a run pins its revision, content hash and model route', async () => {
  const definition = gateFlow()
  definition.nodes[0].model = 'strong'
  const runner = fakeRunner({ draft: [{ status: 'done', output: { points: [] } }] })
  const { service, seeded } = await setup(definition, { runner })
  try {
    const run = await startAndWait(service, seeded.workspace)
    assert.match(run.contentHash, /^sha256:/u)
    assert.equal(run.revision, 1)
    assert.deepEqual(run.routes.draft, { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' })
    assert.deepEqual(runner.calls[0].agentOptions, { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' })
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a missing model layer refuses the run instead of falling back', async () => {
  const definition = gateFlow()
  definition.nodes[0].model = 'missing'
  const { service, seeded } = await setup(definition, {})
  try {
    await assert.rejects(() => service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } }), (error) => error.code === 'flow-invalid')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('without VibeStack, starting and publishing are refused but listing still works', async () => {
  const { service, seeded } = await setup(gateFlow(), { vibestack: null })
  try {
    const flows = await service.listFlows(seeded.workspace)
    assert.equal(flows.length, 1)
    await assert.rejects(() => service.run({ cwd: seeded.workspace, key: 'demo' }), (error) => error.code === 'vibestack-unavailable')
    await assert.rejects(() => service.publish({ cwd: seeded.workspace, key: 'demo' }), (error) => error.code === 'vibestack-unavailable')
    const snapshot = await service.snapshot([{ path: seeded.workspace }])
    assert.equal(snapshot.degraded, true)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('cancel stops a waiting run and records the reason', async () => {
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: [] } }] } })
  try {
    const run = await startAndWait(service, seeded.workspace)
    assert.equal(run.status, 'waiting_human')
    await service.cancel(run.runId)
    const after = await service.getRun(run.runId)
    assert.equal(after.status, 'cancelled')
    assert.equal(after.error.code, 'cancelled')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('gate branches converge through a merge that tolerates the skipped side', async () => {
  const definition = {
    schemaVersion: 2,
    flow: { id: 'fl-branch', name: '分支汇合' },
    input: { type: 'object', properties: {} },
    nodes: [
      { id: 'draft', type: 'agent', preset: 'hnflow', instruction: 'draft', output: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false } },
      { id: 'approve', type: 'gate', title: '确认' },
      { id: 'integrate', type: 'agent', preset: 'hnflow', instruction: 'integrate', output: { type: 'object', required: ['changes'], properties: { changes: { type: 'array' } }, additionalProperties: false } },
      { id: 'decline', type: 'agent', preset: 'hnflow', instruction: 'decline', output: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } }, additionalProperties: false } },
      { id: 'collect', type: 'merge', from: ['integrate', 'decline'], output: { type: 'object', required: ['changes'], properties: { changes: { type: 'array' }, reason: { type: 'string' } }, additionalProperties: false } },
    ],
    edges: [
      { id: 'e1', from: 'draft', to: 'approve', when: { kind: 'status', is: 'done' } },
      { id: 'e2', from: 'approve', to: 'integrate', when: { kind: 'gate', is: 'approved' } },
      { id: 'e3', from: 'approve', to: 'integrate', when: { kind: 'gate', is: 'modified' } },
      { id: 'e4', from: 'approve', to: 'decline', when: { kind: 'gate', is: 'rejected' } },
      { id: 'e5', from: 'integrate', to: 'collect', when: { kind: 'status', is: 'done' } },
      { id: 'e6', from: 'decline', to: 'collect', when: { kind: 'status', is: 'done' } },
    ],
  }
  const { service, seeded } = await setup(definition, {
    script: { draft: [{ status: 'done', output: { ok: true } }], integrate: [{ status: 'done', output: { changes: ['x'] } }] },
  })
  try {
    const run = await startAndWait(service, seeded.workspace, {})
    assert.equal(run.status, 'waiting_human')
    const [item] = await service.inbox()
    const settled = await (await service.decide({ runId: run.runId, gateId: item.id, decision: 'approved', revision: item.revision })).settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.decline.status, 'skipped')
    assert.deepEqual(settled.nodes.collect.output, { changes: ['x'] })
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a workspace override runs as a draft snapshot, not the published revision', async () => {
  const runner = fakeRunner({ draft: [{ status: 'done', output: { points: ['a'] } }] })
  const { service, seeded } = await setup(gateFlow(), { runner })
  try {
    const { WorkspaceStore } = await import('../lib/workspace.js')
    const definition = gateFlow()
    definition.nodes[0].instruction = '覆盖后的指令：{{input.brief}}'
    await new WorkspaceStore(seeded.workspace, {}).writeOverride({ flowId: 'fl-test', definition, baseRevision: 1, origin: 'user' })
    const run = await startAndWait(service, seeded.workspace)
    assert.equal(run.source, 'override')
    assert.match(runner.calls[0].prompt, /覆盖后的指令/u)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('publishing advances the revision and freezes the lockfile', async () => {
  const { service, seeded } = await setup(gateFlow(), {})
  try {
    const published = await service.publish({ cwd: seeded.workspace, key: 'demo', note: 'test' })
    assert.equal(published.revision, 2)
    assert.match(published.contentHash, /^sha256:/u)
    const { AssetStore } = await import('../lib/assets.js')
    const record = await new AssetStore(seeded.library).readRevisionRecord('fl-test', 2)
    assert.equal(record.lockfile.revision, 2)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('open() marks runs left by a previous process as interrupted', async () => {
  const store = memoryStore()
  await store.putRun({
    runId: 'run-stale',
    flowId: 'fl-test',
    flowName: 'x',
    workspace: '/w',
    status: 'running',
    revision: 1,
    nodes: { draft: { status: 'running', attempts: 1 } },
    pending: [],
    startedAt: new Date().toISOString(),
  })
  const service = await makeService({ store, config: { resumeOnStart: false } })
  try {
    const run = await service.getRun('run-stale')
    assert.equal(run.status, 'interrupted')
    assert.equal(run.nodes.draft.status, 'interrupted')
    assert.equal(run.error.code, 'interrupted')
  } finally {
    await service.close()
  }
})

test('open() resumes interrupted runs when resumeOnStart is on', async () => {
  const store = memoryStore()
  await store.putRun({
    runId: 'run-resume',
    flowId: 'fl-test',
    flowName: 'x',
    workspace: '/w',
    status: 'interrupted',
    revision: 1,
    nodes: { draft: { status: 'interrupted', attempts: 1 } },
    pending: [],
    startedAt: new Date().toISOString(),
  })
  const service = await makeService({ store })
  try {
    const run = await service.getRun('run-resume')
    assert.equal(run.recovery.reason, 'host-restarted')
    assert.notEqual(run.status, 'interrupted')
    assert.notEqual(run.nodes.draft.status, 'interrupted')
  } finally {
    await service.close()
  }
})
