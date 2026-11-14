/**
 * The human surface: audit facts, delivery path safety and expiry transitions.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'

import { deliveryFlow, gateFlow, makeService, seedWorkspace } from './helpers.js'

/**
 * Seed a workspace and build a service over it.
 * @param {Record<string, any>} definition - flow.
 * @param {Record<string, any>} [options] - seams.
 * @returns {Promise<{service: Record<string, any>, seeded: Record<string, any>}>} service and paths.
 */
async function setup(definition, options = {}) {
  const seeded = await seedWorkspace(definition)
  const service = await makeService({
    script: options.script ?? {},
    config: { libraryRoot: seeded.library },
    runner: options.runner,
    now: options.now,
    fs: options.fs,
    sessions: options.sessions,
  })
  return { service, seeded }
}

/**
 * Wait until a predicate holds.
 * @param {() => Promise<boolean>} check - predicate.
 * @returns {Promise<void>} resolves once true.
 */
async function waitFor(check) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition did not become true')
}

test('a gate records the upstream hash, consumers and channel before it is asked', async () => {
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: ['a'] } }] } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } })).settled
    const [item] = await service.inbox()
    assert.equal(item.askedVia, 'inbox')
    assert.equal(item.flowRevision, null)
    assert.equal(item.flowSource, 'capability')
    assert.match(item.contentHash, /^sha256:/u)
    assert.match(item.upstreamHash, /^sha256:/u)
    assert.deepEqual(item.consumerNodeIds, [])
    assert.equal(typeof item.askedAt, 'string')

    const settled = await (await service.decide({ runId: run.runId, gateId: item.id, decision: 'approved', revision: item.revision })).settled
    const [audit] = settled.audit
    assert.equal(audit.decidedBy, 'owner')
    assert.equal(audit.askedVia, 'inbox')
    assert.equal(audit.flowRevision, null)
    assert.equal(audit.contentHash, item.contentHash)
    assert.deepEqual(audit.consumerNodeIds, [])
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a modified gate decision can carry the modified artifact into the run', async () => {
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: ['a'] } }] } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } })).settled
    const [item] = await service.inbox()
    const settled = await (
      await service.decide({
        runId: run.runId,
        gateId: item.id,
        decision: 'modified',
        reason: '补一条',
        revision: item.revision,
        artifact: { points: ['a', 'b'] },
      })
    ).settled
    assert.equal(settled.status, 'succeeded')
    assert.deepEqual(settled.nodes.approve.output.artifact, { points: ['a', 'b'] })
    assert.deepEqual(settled.artifactRevisions[0].value, { points: ['a', 'b'] })
    assert.equal(settled.artifactRevisions[0].nodeId, 'approve')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a delivery gets an id, an owner and its consumer nodes', async () => {
  const { service, seeded } = await setup(deliveryFlow(), { script: { integrate: [{ status: 'done', output: { changes: [] } }] } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [item] = await service.inbox()
    assert.deepEqual(item.consumerNodeIds, ['accept'])
    const settled = await (await service.deliver({ runId: run.runId, requestId: item.id, payload: { files: ['art/a.png'] }, revision: item.revision })).settled
    const delivery = settled.audit.find((entry) => entry.kind === 'delivery')
    assert.match(delivery.deliveryId, /^del-/u)
    assert.equal(delivery.decidedBy, 'owner')
    assert.deepEqual(delivery.consumerNodeIds, ['accept'])
    assert.equal(settled.pending[0].deliveryId, delivery.deliveryId)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a delivery path that escapes the workspace is refused', async () => {
  const { service, seeded } = await setup(deliveryFlow(), { script: { integrate: [{ status: 'done', output: { changes: [] } }] } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [item] = await service.inbox()
    for (const payload of [{ files: ['../outside.png'] }, { files: ['C:/outside.png'] }, { files: ['a/../../outside.png'] }]) {
      await assert.rejects(
        () => service.deliver({ runId: run.runId, requestId: item.id, payload, revision: item.revision }),
        (error) => error.code === 'path-outside-workspace',
      )
    }
    const stillOpen = await service.getRun(run.runId)
    assert.equal(stillOpen.status, 'waiting_human')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a filesystem provider that denies containment is honoured', async () => {
  const fs = {
    resolve: async (value) => ({ path: value }),
    contains: (parent, child) => !String(child.path).includes('denied'),
  }
  const { service, seeded } = await setup(deliveryFlow(), {
    script: { integrate: [{ status: 'done', output: { changes: [] } }] },
    fs,
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [item] = await service.inbox()
    await assert.rejects(
      () => service.deliver({ runId: run.runId, requestId: item.id, payload: { files: ['denied/a.png'] }, revision: item.revision }),
      (error) => error.code === 'path-outside-workspace',
    )
    const settled = await (
      await service.deliver({ runId: run.runId, requestId: item.id, payload: { files: ['ok/a.png'] }, revision: item.revision })
    ).settled
    assert.equal(settled.status, 'succeeded')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('an expired request with onExpire fail fails the node and advances the run', async () => {
  let clock = new Date('2026-01-01T00:00:00.000Z')
  const definition = deliveryFlow()
  definition.nodes[0].deadline = { hours: 1 }
  definition.nodes[0].onExpire = 'fail'
  const { service, seeded } = await setup(definition, { now: () => clock })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    assert.equal(run.status, 'waiting_human')
    clock = new Date('2026-01-01T02:00:00.000Z')
    await service.sweepExpired()
    await waitFor(async () => (await service.getRun(run.runId)).status !== 'waiting_human')
    const after = await service.getRun(run.runId)
    assert.equal(after.status, 'failed')
    assert.equal(after.nodes.art.status, 'failed')
    assert.equal(after.nodes.art.diagnostic.code, 'request-expired')
    assert.equal(after.audit.some((entry) => entry.kind === 'expired'), true)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('an expired gate with remind stays open, marked expired', async () => {
  let clock = new Date('2026-01-01T00:00:00.000Z')
  const definition = gateFlow()
  definition.nodes[1].deadline = { hours: 1 }
  const { service, seeded } = await setup(definition, { script: { draft: [{ status: 'done', output: { points: [] } }] }, now: () => clock })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } })).settled
    clock = new Date('2026-01-01T02:00:00.000Z')
    await service.sweepExpired()
    await waitFor(async () => (await service.getRun(run.runId)).pending[0]?.expired === true)
    const after = await service.getRun(run.runId)
    assert.equal(after.status, 'waiting_human')
    assert.equal((await service.inbox())[0].expired, true)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
