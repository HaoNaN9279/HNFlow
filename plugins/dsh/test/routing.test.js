/**
 * Routing after a judgement that is not a clean accept: inconclusive verifies
 * go to a gate, and an exhausted rejection budget can be arbitrated.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'

import { deliveryFlow, makeService, seedWorkspace } from './helpers.js'

/**
 * Seed and build.
 * @param {Record<string, any>} definition - flow.
 * @param {Record<string, any>} script - per-node envelopes.
 * @returns {Promise<{service: Record<string, any>, seeded: Record<string, any>}>} service and paths.
 */
async function setup(definition, script) {
  const seeded = await seedWorkspace(definition)
  const service = await makeService({ script, config: { libraryRoot: seeded.library } })
  return { service, seeded }
}

/**
 * A delivery flow whose verify asks a judge.
 * @returns {Record<string, any>} definition.
 */
function judgedDelivery() {
  const definition = deliveryFlow()
  definition.nodes[1].checks = ['schema', 'judge']
  definition.nodes[1].judge = { preset: 'standard', criteria: '像样' }
  return definition
}

test('a needs_more verdict parks on a gate, and approval records the arbitration', async () => {
  const { service, seeded } = await setup(judgedDelivery(), {
    'accept:judge': [{ status: 'done', output: { verdict: 'needs_more', reasons: ['还需要一张背面图'] } }],
    integrate: [{ status: 'done', output: { changes: [] } }],
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [request] = await service.inbox()
    const delivered = await (await service.deliver({ runId: run.runId, requestId: request.id, payload: { files: ['a.png'] }, revision: request.revision })).settled
    assert.equal(delivered.status, 'waiting_human')
    assert.equal(delivered.nodes.accept.status, 'waiting')
    const [gate] = await service.inbox()
    assert.equal(gate.kind, 'gate')
    assert.equal(gate.origin, 'inconclusive')
    assert.equal(gate.nodeId, 'accept')

    const settled = await (await service.decide({ runId: run.runId, gateId: gate.id, decision: 'approved', revision: gate.revision })).settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.accept.status, 'done')
    assert.equal(settled.nodes.accept.output.accepted, true)
    assert.equal(settled.nodes.accept.output.arbitrated, true)
    assert.equal(settled.audit.some((entry) => entry.nodeId === 'accept'), true)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('onInconclusive fail makes the verify fail instead of asking a human', async () => {
  const definition = judgedDelivery()
  definition.nodes[1].onInconclusive = 'fail'
  const { service, seeded } = await setup(definition, {
    'accept:judge': [{ status: 'done', output: { verdict: 'needs_more', reasons: ['不够'] } }],
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [request] = await service.inbox()
    const settled = await (await service.deliver({ runId: run.runId, requestId: request.id, payload: { files: ['a.png'] }, revision: request.revision })).settled
    assert.equal(settled.status, 'failed')
    assert.equal(settled.nodes.accept.status, 'failed')
    assert.equal(settled.nodes.accept.diagnostic.code, 'judge-needs-more')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a judge reject is a verdict the edges can route, not a node failure', async () => {
  const definition = {
    schemaVersion: 2,
    flow: { id: 'fl-judge-route', name: '裁决路由' },
    input: { type: 'object', properties: {}, additionalProperties: true },
    nodes: [
      { id: 'draft', type: 'agent', preset: 'hnflow', instruction: 'draft', output: { type: 'object', required: ['v'], properties: { v: { type: 'string' } }, additionalProperties: false } },
      { id: 'judge', type: 'judge', preset: 'standard', instruction: 'judge', criteria: '够不够好' },
      { id: 'good', type: 'agent', preset: 'hnflow', instruction: 'good', output: { type: 'object', required: ['v'], properties: { v: { type: 'string' } }, additionalProperties: false } },
      { id: 'bad', type: 'agent', preset: 'hnflow', instruction: 'bad', output: { type: 'object', required: ['v'], properties: { v: { type: 'string' } }, additionalProperties: false } },
      { id: 'collect', type: 'merge', from: ['good', 'bad'], output: { type: 'object', properties: { v: { type: 'string' } }, additionalProperties: false } },
    ],
    edges: [
      { id: 'e1', from: 'draft', to: 'judge', when: { kind: 'always' } },
      { id: 'e2', from: 'judge', to: 'good', when: { kind: 'verdict', is: 'accept' } },
      { id: 'e3', from: 'judge', to: 'bad', when: { kind: 'verdict', is: 'reject' } },
      { id: 'e4', from: 'good', to: 'collect', when: { kind: 'status', is: 'done' } },
      { id: 'e5', from: 'bad', to: 'collect', when: { kind: 'status', is: 'done' } },
    ],
  }
  const { service, seeded } = await setup(definition, {
    draft: [{ status: 'done', output: { v: 'draft' } }],
    judge: [{ status: 'done', output: { verdict: 'reject', reasons: ['不合格'] } }],
    bad: [{ status: 'done', output: { v: 'revised' } }],
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    assert.equal(run.status, 'succeeded')
    assert.equal(run.nodes.judge.status, 'done')
    assert.equal(run.nodes.judge.verdict, 'reject')
    assert.equal(run.nodes.good.status, 'skipped')
    assert.equal(run.nodes.bad.status, 'done')
    assert.deepEqual(run.nodes.collect.output, { v: 'revised' })
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a judge with a malformed verdict parks on a gate instead of failing', async () => {
  const definition = {
    schemaVersion: 2,
    flow: { id: 'fl-judge-gate', name: '裁决不确定' },
    input: { type: 'object', properties: {}, additionalProperties: true },
    nodes: [
      { id: 'draft', type: 'agent', preset: 'hnflow', instruction: 'draft', output: { type: 'object', properties: {}, additionalProperties: true } },
      { id: 'judge', type: 'judge', preset: 'standard', instruction: 'judge', criteria: '随便' },
    ],
    edges: [{ id: 'e1', from: 'draft', to: 'judge', when: { kind: 'always' } }],
  }
  const { service, seeded } = await setup(definition, {
    draft: [{ status: 'done', output: {} }],
    judge: [{ status: 'done', output: { verdict: 'maybe' } }],
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    assert.equal(run.status, 'waiting_human')
    assert.equal(run.nodes.judge.status, 'waiting')
    const [gate] = await service.inbox()
    assert.equal(gate.origin, 'inconclusive')
    const settled = await (await service.decide({ runId: run.runId, gateId: gate.id, decision: 'approved', reason: '接受', revision: gate.revision })).settled
    assert.equal(settled.nodes.judge.status, 'done')
    assert.equal(settled.nodes.judge.verdict, 'accept')
    assert.equal(settled.status, 'succeeded')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('an arbitrated delivery continues the run and records conditions', async () => {
  const definition = judgedDelivery()
  definition.nodes[1].onReject = { kind: 'arbitrate', maxAttempts: 1, judge: { preset: 'standard' } }
  const { service, seeded } = await setup(definition, {
    'accept:judge': [{ status: 'done', output: { verdict: 'reject', reasons: ['分辨率不足'] } }],
    'art:arbitrate': [{ status: 'done', output: { verdict: 'accept', reasons: ['宣传图可用'], conditions: ['仅限缩略图'] } }],
    integrate: [{ status: 'done', output: { changes: [] } }],
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [request] = await service.inbox()
    const settled = await (await service.deliver({ runId: run.runId, requestId: request.id, payload: { files: ['a.png'] }, revision: request.revision })).settled
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.nodes.accept.status, 'done')
    assert.equal(settled.nodes.accept.output.arbitrated, true)
    assert.deepEqual(settled.nodes.accept.output.conditions, ['仅限缩略图'])
    const arbitration = settled.audit.find((entry) => entry.kind === 'arbitration')
    assert.equal(arbitration.decidedBy, 'judge')
    assert.deepEqual(arbitration.verdict.conditions, ['仅限缩略图'])
    const artifact = await service.getArtifact(settled.nodes.art.artifactId)
    assert.equal(artifact.accepted, true)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
