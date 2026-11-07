/**
 * Revision history, publish previews and rollback/pin as human actions.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'

import { gateFlow, makeService, seedWorkspace } from './helpers.js'

test('history, diff preview, rollback and pin are consistent', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const service = await makeService({ config: { libraryRoot: seeded.library } })
  try {
    const first = await service.history(seeded.workspace, 'demo')
    assert.equal(first.currentRevision, 1)
    assert.deepEqual(first.revisions.map((entry) => entry.revision), [1])

    // A draft override is a candidate, not a revision: the preview must show
    // the structural change and publish must remain an explicit call.
    const modified = gateFlow()
    modified.nodes[0].instruction = '覆盖后的指令：{{input.brief}}'
    await service.draft({ cwd: seeded.workspace, key: 'demo', definition: modified, origin: 'user' })
    const preview = await service.previewPublish(seeded.workspace, 'demo')
    assert.equal(preview.nextRevision, 2)
    assert.equal(preview.validation.ok, true)
    assert.equal(preview.diff.changed, true)
    assert.equal(preview.diff.nodes.changed.some((entry) => entry.id === 'draft' && entry.fields.includes('instruction')), true)
    assert.equal((await service.history(seeded.workspace, 'demo')).revisions.length, 1)

    const published = await service.publish({ cwd: seeded.workspace, key: 'demo', note: 'r2' })
    assert.equal(published.revision, 2)
    const { AssetStore } = await import('../lib/assets.js')
    const r2 = await new AssetStore(seeded.library).readRevisionRecord('fl-test', 2)
    assert.deepEqual(r2.lockfile.presets.hnflow.composition, [{ moduleName: 'dsh-vibestack', enabled: true }])
    const after = await service.history(seeded.workspace, 'demo')
    assert.deepEqual(after.revisions.map((entry) => entry.revision), [2, 1])

    const rolled = await service.rollback({ cwd: seeded.workspace, key: 'demo', revision: 1, note: 'back' })
    assert.equal(rolled.revision, 3)
    assert.equal(rolled.restoredFrom, 1)
    const restored = await new AssetStore(seeded.library).readRevisionRecord(rolled.asset.id ?? 'fl-test', 3)
    assert.equal(restored.definition.nodes[0].instruction, gateFlow().nodes[0].instruction)

    const pinned = await service.pinRef(seeded.workspace, 'demo', 1)
    assert.equal(pinned.revision, 1)
    const { WorkspaceStore } = await import('../lib/workspace.js')
    await new WorkspaceStore(seeded.workspace, {}).removeOverride('fl-test')
    const resolved = await service.describeFlow(seeded.workspace, 'demo')
    assert.equal(resolved.revision, 1)
    assert.equal(resolved.source, 'ref')
    const latest = await service.pinRef(seeded.workspace, 'demo', 'latest')
    assert.equal(latest.revision, null)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
