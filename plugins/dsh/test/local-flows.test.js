/**
 * Project-local flows: creation, editing, running, promotion and reference
 * management. A local flow is an override without a library reference.
 */

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'

import { gateFlow, makeService, seedWorkspace } from './helpers.js'

test('a project-local flow can be created, run, edited and promoted', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const service = await makeService({
    config: { libraryRoot: seeded.library },
    script: { draft: [{ status: 'done', output: { points: ['local'] } }] },
  })
  try {
    const created = await service.createFlow({ cwd: seeded.workspace, definition: gateFlow(), name: '本地流程', folder: 'team/local' })
    assert.equal(created.scope, 'project')
    assert.equal(created.local, true)
    assert.match(created.flowId, /^fl-local-/u)
    await assert.rejects(() => service.createFlow({ cwd: seeded.workspace, definition: gateFlow(), name: '逃逸', folder: '../outside' }), (error) => error.code === 'folder-invalid')
    await assert.rejects(() => service.createFlow({ cwd: seeded.workspace, definition: gateFlow(), name: '本地流程' }), (error) => error.code === 'name-duplicate')

    const flows = await service.listFlows(seeded.workspace)
    const local = flows.find((entry) => entry.flowId === created.flowId)
    assert.equal(local.local, true)
    assert.equal(local.name, '本地流程')
    assert.equal(local.folder, 'team/local')

    const resolved = await service.describeFlow(seeded.workspace, '本地流程')
    assert.equal(resolved.source, 'local')
    assert.equal(resolved.revision, null)
    assert.equal(resolved.definition.flow.id, created.flowId)

    const started = await service.run({ cwd: seeded.workspace, key: '本地流程', input: { brief: 'x' } })
    const waiting = await started.settled
    assert.equal(waiting.status, 'waiting_human')
    assert.equal(waiting.source, 'local')
    assert.equal(waiting.revision, null)
    assert.equal(waiting.nodes.draft.status, 'done')
    await service.cancel(waiting.runId)

    const edited = await service.draft({
      cwd: seeded.workspace,
      key: '本地流程',
      definition: { ...resolved.definition, nodes: resolved.definition.nodes.map((node) => (node.id === 'draft' ? { ...node, instruction: '改过的任务' } : node)) },
      note: 'local edit',
    })
    assert.equal(edited.local, true)
    assert.equal(edited.validation.ok, true)
    const afterEdit = await service.describeFlow(seeded.workspace, created.flowId)
    assert.equal(afterEdit.definition.nodes[0].instruction, '改过的任务')

    await assert.rejects(() => service.history(seeded.workspace, created.flowId), /project-local draft/u)
    await assert.rejects(() => service.pinRef(seeded.workspace, created.flowId, 'latest'), /project-local draft/u)
    await assert.rejects(() => service.publish({ cwd: seeded.workspace, key: created.flowId }), /project-local draft/u)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('local flows can be renamed and deleted, and promoted into the library', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const service = await makeService({ config: { libraryRoot: seeded.library } })
  try {
    const created = await service.createFlow({ cwd: seeded.workspace, definition: gateFlow(), name: '草稿流程' })
    const renamed = await service.renameLocal({ cwd: seeded.workspace, key: created.flowId, name: '改名流程' })
    assert.equal(renamed.name, '改名流程')
    assert.equal((await service.describeFlow(seeded.workspace, created.flowId)).flowName, '改名流程')

    const promoted = await service.promote({ cwd: seeded.workspace, key: created.flowId, folder: 'promoted/team' })
    assert.equal(promoted.scope, 'library')
    assert.notEqual(promoted.flowId, created.flowId)
    const listed = await service.listFlows(seeded.workspace)
    assert.equal(listed.some((entry) => entry.flowId === created.flowId), false)
    const ref = listed.find((entry) => entry.flowId === promoted.flowId)
    assert.equal(ref.local, false)
    assert.equal(ref.folder, 'promoted/team')
    assert.equal(ref.currentRevision, 1)
    await assert.rejects(() => service.deleteLocal({ cwd: seeded.workspace, key: created.flowId }), (error) => error.code === 'ref-missing')

    const second = await service.createFlow({ cwd: seeded.workspace, definition: gateFlow(), name: '待删除' })
    const deleted = await service.deleteLocal({ cwd: seeded.workspace, key: second.flowId })
    assert.equal(deleted.local, true)
    await assert.rejects(() => service.describeFlow(seeded.workspace, second.flowId), (error) => error.code === 'ref-missing')

    const { id: _ignored, ...flowWithoutId } = gateFlow().flow
    const noId = await service.createFlow({ cwd: seeded.workspace, definition: { ...gateFlow(), flow: flowWithoutId }, name: '无标识流程' })
    assert.equal(noId.local, true)
    assert.match(noId.flowId, /^fl-local-/u)
    const noName = await service.createFlow({ cwd: seeded.workspace, definition: { ...gateFlow(), flow: { description: '只有名称参数' } }, name: '仅名称流程' })
    assert.equal(noName.local, true)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('library creation and reference management work by id or name', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const service = await makeService({ config: { libraryRoot: seeded.library } })
  try {
    const created = await service.createFlow({ cwd: seeded.workspace, definition: gateFlow(), name: '通用流程', scope: 'library', folder: 'shared/a' })
    assert.equal(created.scope, 'library')
    assert.equal(created.referenced, true)
    const library = await service.listLibrary()
    const asset = library.find((entry) => entry.id === created.flowId)
    assert.equal(asset.folder, 'shared/a')
    assert.equal(asset.revision, 1)
    assert.equal((await service.describeFlow(seeded.workspace, '通用流程')).flowId, created.flowId)

    const renamed = await service.renameRef({ cwd: seeded.workspace, key: created.flowId, alias: 'shared' })
    assert.equal(renamed.alias, 'shared')
    const removed = await service.removeRef({ cwd: seeded.workspace, key: 'shared' })
    assert.equal(removed.flowId, created.flowId)
    assert.equal((await service.listFlows(seeded.workspace)).some((entry) => entry.flowId === created.flowId), false)

    const added = await service.addRef(seeded.workspace, '通用流程', 'again')
    assert.equal(added.alias, 'again')
    const pinned = await service.pinRef(seeded.workspace, 'again', 1)
    assert.equal(pinned.revision, 1)
    const history = await service.history(seeded.workspace, 'again')
    assert.equal(history.currentRevision, 1)
    assert.equal(history.revisions.length, 1)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
