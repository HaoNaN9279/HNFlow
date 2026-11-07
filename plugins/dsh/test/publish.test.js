/**
 * Publishing: content hashes, lockfiles and immutable snapshots.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { AssetStore } from '../lib/assets.js'
import { buildLockfile, contentHash, lockfileProblems, publishFlow } from '../lib/flow/publish.js'
import { fakeVibestack, seedWorkspace } from './helpers.js'

/**
 * A flow with one model-pinned node.
 * @returns {Record<string, any>} definition.
 */
function definition() {
  return {
    schemaVersion: 2,
    flow: { id: 'fl-pub', name: '发布测试', revision: 1 },
    input: { type: 'object', properties: {} },
    nodes: [{ id: 'draft', type: 'agent', preset: 'hnflow', model: 'strong', instruction: 'x', output: { type: 'object', required: ['points'], properties: { points: { type: 'array' } } } }],
    edges: [],
  }
}

test('the content hash ignores revision bookkeeping', () => {
  const first = definition()
  const second = definition()
  second.flow.revision = 9
  second.flow.updatedAt = '2026-01-01T00:00:00.000Z'
  assert.equal(contentHash(first), contentHash(second))
  second.nodes[0].instruction = 'y'
  assert.notEqual(contentHash(first), contentHash(second))
})

test('the lockfile freezes presets, schema hashes and model routes', async () => {
  const vibestack = fakeVibestack()
  const lockfile = await buildLockfile({
    definition: definition(),
    revision: 3,
    pluginVersion: '0.3.0',
    vibestack,
    layerStatus: async (id) => (id === 'strong' ? { ok: true, layer: vibestack.resolveLayer(id) } : { ok: false, message: 'missing' }),
    presetStatus: async () => ({ ok: true, composition: [{ moduleName: 'dsh-vibestack', enabled: true }] }),
  })
  assert.equal(lockfile.revision, 3)
  assert.equal(lockfile.pluginVersion, '0.3.0')
  assert.equal(lockfile.vibestack.apiVersion, 2)
  assert.equal(lockfile.nodes.draft.model, 'strong')
  assert.match(lockfile.nodes.draft.outputHash, /^sha256:/u)
  assert.deepEqual(lockfile.presets, { hnflow: { ok: true, composition: [{ moduleName: 'dsh-vibestack', enabled: true }] } })
  assert.equal(lockfile.models.strong.provider, 'deepseek-account')
  assert.equal(lockfile.models.strong.reasoningEffort, 'high')
})

test('publishing stores an immutable snapshot with its lockfile', async () => {
  const seeded = await seedWorkspace(definition(), { pinned: null })
  try {
    const assets = new AssetStore(seeded.library)
    const lockfile = await buildLockfile({ definition: definition(), revision: 2, pluginVersion: '0.3.0', vibestack: fakeVibestack() })
    const published = await publishFlow({ assets, definition: definition(), note: 'first', lockfile })
    assert.equal(published.revision, 2)
    const record = await assets.readRevisionRecord('fl-pub', 2)
    assert.equal(record.definition.flow.id, 'fl-pub')
    assert.equal(record.lockfile.revision, 2)
    assert.equal(record.lockfile.nodes.draft.outputHash.startsWith('sha256:'), true)
    assert.equal(await assets.readRevisionRecord('fl-pub', 99), null)
  } finally {
    await rm(path.dirname(seeded.library), { recursive: true, force: true })
  }
})

test('a lockfile from another plugin major or a newer VibeStack is reported', () => {
  const current = { pluginVersion: '0.3.0', vibestack: fakeVibestack() }
  assert.equal(lockfileProblems({ pluginVersion: '0.3.0', vibestack: { apiVersion: 2 } }, current).ok, true)
  const minor = lockfileProblems({ pluginVersion: '0.3.1', vibestack: { apiVersion: 2 } }, current)
  assert.equal(minor.ok, true)
  assert.equal(minor.warnings.length, 1)
  assert.equal(lockfileProblems({ pluginVersion: '0.4.0', vibestack: { apiVersion: 2 } }, current).ok, true)
  assert.equal(lockfileProblems({ pluginVersion: '1.0.0', vibestack: { apiVersion: 2 } }, current).ok, false)
  assert.equal(lockfileProblems({ pluginVersion: '0.3.0', vibestack: { apiVersion: 3 } }, current).ok, false)
  assert.equal(lockfileProblems(null, current).ok, false)
})
