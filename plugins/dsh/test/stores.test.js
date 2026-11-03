/**
 * Asset library, workspace refs, and resolution order.
 *
 * These are the contract tests for "assets are reused, workspaces only point at
 * them" — the part of the design most likely to rot.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AssetError, AssetStore, definitionProblems } from '../lib/assets.js'
import { canonicalJson, diffDocuments, hashOf } from '../lib/json.js'
import { ResolveError, createStores } from '../lib/resolve.js'
import { WorkspaceError, WorkspaceStore } from '../lib/workspace.js'

/** A minimal start → assign → end definition. */
function definition(value = 'hello') {
  return {
    id: 'hello-workflow',
    name: 'Hello workflow',
    version: '0.1.0',
    nodes: [
      { id: 'start', type: 'flow:start', outputs: [{ name: 'out', type: 'data' }] },
      { id: 'greet', type: 'data:assign', inputs: [{ name: 'in', type: 'data' }], outputs: [{ name: 'out', type: 'data' }], params: { value } },
      { id: 'end', type: 'flow:end', inputs: [{ name: 'in', type: 'data' }] },
    ],
    edges: [
      { source: 'start', source_port: 'out', target: 'greet', target_port: 'in' },
      { source: 'greet', source_port: 'out', target: 'end', target_port: 'in' },
    ],
  }
}

/**
 * Create an isolated library + workspace pair.
 * @returns {Promise<{assets: AssetStore, workspace: WorkspaceStore, resolver: any, libraryRoot: string, cwd: string}>} stores.
 */
async function makeStores() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-test-'))
  const libraryRoot = path.join(root, 'library')
  const cwd = path.join(root, 'workspace')
  const stores = createStores({ cwd, config: {}, libraryRoot, logger: {} })
  return { ...stores, libraryRoot, cwd }
}

test('json helpers compare canonically and diff leaves', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.equal(hashOf({ a: 1 }), hashOf({ a: 1 }))
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }))
  const changes = diffDocuments({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })
  assert.deepEqual(changes, [{ path: 'b.c', from: 2, to: 3 }])
})

test('definition shape check names the broken member', () => {
  assert.deepEqual(definitionProblems(definition()), [])
  assert.match(definitionProblems({ id: 'x', nodes: [], edges: [] }).join(';'), /nodes/u)
  assert.match(definitionProblems(null).join(';'), /JSON object/u)
})

test('create stores revision 1 and keeps an immutable snapshot', async () => {
  const { assets } = await makeStores()

  const created = await assets.create({ name: 'Hello', definition: definition('v1') })
  assert.equal(created.asset.revision, 1)
  assert.match(created.asset.id, /^wf-[0-9a-f]{12}$/u)

  const listed = await assets.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Hello')

  const snapshot = await assets.readRevision(created.asset.id, 1)
  assert.equal(snapshot.nodes[1].params.value, 'v1')
})

test('save bumps the revision and keeps the previous snapshot addressable', async () => {
  const { assets } = await makeStores()
  const created = await assets.create({ name: 'Hello', definition: definition('v1') })

  const saved = await assets.save({ assetId: created.asset.id, definition: definition('v2'), note: 'target changed' })
  assert.equal(saved.revision, 2)
  assert.equal(saved.asset.lastNote, 'target changed')

  assert.equal((await assets.read(created.asset.id)).asset.revision, 2)
  assert.equal((await assets.readRevision(created.asset.id, 1)).nodes[1].params.value, 'v1')
  assert.equal((await assets.readRevision(created.asset.id, 2)).nodes[1].params.value, 'v2')
})

test('unknown asset id is a stable error', async () => {
  const { assets } = await makeStores()
  await assert.rejects(assets.read('wf-nope'), (error) => error instanceof AssetError && error.code === 'asset-missing')
})

test('the library scan ignores dot-directories and malformed files', async () => {
  const { assets, libraryRoot } = await makeStores()
  await assets.create({ name: 'Keep', definition: definition() })
  await writeFile(path.join(libraryRoot, 'broken.workflow.json'), '{ not json', 'utf8')

  const listed = await assets.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Keep')
})

test('refs reject duplicates and remove by alias', async () => {
  const { workspace } = await makeStores()
  await workspace.addRef({ assetId: 'wf-a', alias: 'publish', revision: 3 })
  await assert.rejects(workspace.addRef({ assetId: 'wf-a', alias: 'other', revision: 3 }), (error) => error instanceof WorkspaceError && error.code === 'ref-duplicate')
  await assert.rejects(workspace.addRef({ assetId: 'wf-b', alias: 'publish', revision: 1 }), (error) => error.code === 'ref-duplicate')

  assert.equal((await workspace.findRef('publish')).assetId, 'wf-a')
  await workspace.removeRef('publish')
  assert.equal(await workspace.findRef('publish'), null)
})

test('the ref manifest keeps a stable version and shape', async () => {
  const { workspace, cwd } = await makeStores()
  await workspace.addRef({ assetId: 'wf-a', alias: 'publish', revision: 2 })
  const raw = JSON.parse(await readFile(path.join(cwd, '.hnflow', 'workflows.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.refs[0].revision, 2)
})

test('overrides accumulate a bounded change log', async () => {
  const { workspace } = await makeStores()
  await workspace.writeOverride({ assetId: 'wf-a', definition: definition('v1'), baseRevision: 3, note: 'first', origin: 'agent' })
  const second = await workspace.writeOverride({ assetId: 'wf-a', definition: definition('v2'), baseRevision: 3, note: 'second', origin: 'user' })

  assert.equal(second.origin, 'user')
  assert.deepEqual(
    second.changeLog.map((entry) => entry.summary),
    ['first', 'second'],
  )
  assert.equal((await workspace.listOverrides()).size, 1)
  assert.equal(await workspace.removeOverride('wf-a'), true)
  assert.equal(await workspace.removeOverride('wf-a'), false)
})

test('resolution prefers the override, then the pinned snapshot, then latest', async () => {
  const { assets, workspace, resolver } = await makeStores()
  const created = await assets.create({ name: 'Hello', definition: definition('v1') })
  await assets.save({ assetId: created.asset.id, definition: definition('v2') })
  const follower = await assets.create({ name: 'Follower', definition: definition('followed') })

  await workspace.addRef({ assetId: created.asset.id, alias: 'pinned', revision: 1 })
  await workspace.addRef({ assetId: follower.asset.id, alias: 'follow', revision: null })

  const pinned = await resolver.resolve('pinned')
  assert.equal(pinned.source, 'ref')
  assert.equal(pinned.definition.nodes[1].params.value, 'v1')
  assert.equal(pinned.drift, true)
  assert.equal(pinned.currentRevision, 2)

  const latest = await resolver.resolve('follow')
  assert.equal(latest.source, 'latest')
  assert.equal(latest.definition.nodes[1].params.value, 'followed')
  assert.equal(latest.drift, false)

  await workspace.writeOverride({ assetId: created.asset.id, definition: definition('local'), baseRevision: 2, origin: 'agent' })
  const overridden = await resolver.resolve('pinned')
  assert.equal(overridden.source, 'override')
  assert.equal(overridden.definition.nodes[1].params.value, 'local')
  assert.equal(overridden.baseRevision, 2)
  assert.equal(overridden.drift, false)

  await workspace.removeOverride(created.asset.id)
  assert.equal((await resolver.resolve('pinned')).source, 'ref')
})

test('a missing ref, asset, or pinned revision is a distinct error', async () => {
  const { assets, workspace, resolver } = await makeStores()

  await assert.rejects(resolver.resolve('nope'), (error) => error instanceof ResolveError && error.code === 'ref-missing')

  await workspace.addRef({ assetId: 'wf-gone', alias: 'gone', revision: null })
  await assert.rejects(resolver.resolve('gone'), (error) => error.code === 'asset-missing')

  const created = await assets.create({ name: 'Hello', definition: definition() })
  await workspace.addRef({ assetId: created.asset.id, alias: 'pinned', revision: 7 })
  await assert.rejects(resolver.resolve('pinned'), (error) => error.code === 'revision-missing')
})

test('the catalogue survives a missing asset instead of throwing', async () => {
  const { workspace, resolver } = await makeStores()
  await workspace.addRef({ assetId: 'wf-gone', alias: 'gone', revision: null })
  const catalogue = await resolver.catalogue()

  assert.equal(catalogue.length, 1)
  assert.equal(catalogue[0].missing, true)
  assert.equal(catalogue[0].error, 'asset-missing')
})
