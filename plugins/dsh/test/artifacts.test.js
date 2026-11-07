/**
 * Artifacts and degradation marking.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'

import { deliveryFlow, gateFlow, makeService, seedWorkspace } from './helpers.js'

/**
 * Seed and build.
 * @param {Record<string, any>} definition - flow.
 * @param {Record<string, any>} [options] - seams.
 * @returns {Promise<{service: Record<string, any>, seeded: Record<string, any>}>} service and paths.
 */
async function setup(definition, options = {}) {
  const seeded = await seedWorkspace(definition)
  const service = await makeService({ script: options.script ?? {}, config: { libraryRoot: seeded.library }, runner: options.runner, now: options.now })
  return { service, seeded }
}

test('every node output becomes an addressable artifact', async () => {
  const { service, seeded } = await setup(gateFlow(), { script: { draft: [{ status: 'done', output: { points: ['a'] } }] } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } })).settled
    const artifactId = run.nodes.draft.artifactId
    assert.equal(artifactId, `art-${run.runId}-draft`)
    const artifact = await service.getArtifact(artifactId)
    assert.equal(artifact.nodeId, 'draft')
    assert.equal(artifact.kind, 'agent')
    assert.deepEqual(artifact.value, { points: ['a'] })
    assert.match(artifact.schemaHash, /^sha256:/u)
    assert.equal(artifact.degraded, false)
    await assert.rejects(() => service.getArtifact('art-nope'), (error) => error.code === 'artifact-missing')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a human delivery is an accepted artifact with a human source', async () => {
  const { service, seeded } = await setup(deliveryFlow(), { script: { integrate: [{ status: 'done', output: { changes: [] } }] } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    const [item] = await service.inbox()
    const settled = await (await service.deliver({ runId: run.runId, requestId: item.id, payload: { files: ['a.png'] }, revision: item.revision })).settled
    const artifact = await service.getArtifact(settled.nodes.art.artifactId)
    assert.equal(artifact.source, 'human')
    assert.equal(artifact.accepted, true)
    assert.deepEqual(artifact.value, { files: ['a.png'] })
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('a fallback-produced artifact is marked degraded', async () => {
  const definition = {
    schemaVersion: 2,
    flow: { id: 'fl-degraded', name: '降级' },
    input: { type: 'object', properties: {}, additionalProperties: true },
    nodes: [
      { id: 'primary', type: 'agent', preset: 'hnflow', instruction: 'primary', output: { type: 'object', required: ['v'], properties: { v: { type: 'string' } }, additionalProperties: false } },
      { id: 'backup', type: 'agent', preset: 'hnflow', instruction: 'backup', output: { type: 'object', required: ['v'], properties: { v: { type: 'string' } }, additionalProperties: false } },
      { id: 'approve', type: 'gate', title: '确认' },
    ],
    edges: [
      { id: 'e1', from: 'primary', to: 'approve', when: { kind: 'status', is: 'done' } },
      { id: 'e2', from: 'primary', to: 'backup', when: { kind: 'status', is: 'failed' }, onFail: { kind: 'fallback', node: 'backup' } },
      { id: 'e3', from: 'backup', to: 'approve', when: { kind: 'status', is: 'done' } },
    ],
  }
  const { service, seeded } = await setup(definition, {
    script: {
      primary: [{ status: 'failed', error: { code: 'model-failed', message: 'boom' } }],
      backup: [{ status: 'done', output: { v: 'fallback' } }],
    },
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    assert.equal(run.status, 'waiting_human')
    assert.equal(run.degradations.length, 1)
    assert.equal(run.degradations[0].nodeId, 'primary')
    assert.deepEqual(run.degradations[0].fallbackNodeIds, ['backup'])
    assert.equal(run.nodes.backup.degradedFrom, 'primary')
    const artifact = await service.getArtifact(run.nodes.backup.artifactId)
    assert.equal(artifact.degraded, true)
    assert.match(artifact.degradedReason, /primary/u)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
