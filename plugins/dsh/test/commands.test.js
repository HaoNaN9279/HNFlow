/**
 * `/hnflow`: listing, publishing (preview + confirm), pinning and importing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createFlowCommand } from '../lib/commands.js'
import { resolveConfig } from '../lib/config.js'
import { gateFlow, seedWorkspace } from './helpers.js'

const cwdOf = () => '/w'

/**
 * A command over a service stub.
 * @param {Record<string, any>} service - stub.
 * @returns {Record<string, any>} command.
 */
function command(service) {
  return createFlowCommand({ service, cwdOf, config: resolveConfig({}), logger: {} })
}

const service = {
  listFlows: async () => [{ alias: 'demo', flowId: 'fl', pinnedRevision: null, currentRevision: 1, hasOverride: false, drift: false, missing: false, description: '说明' }],
  listRuns: async () => [],
  getRun: async () => ({
    runId: 'run-1',
    flowId: 'fl',
    flowName: '测试',
    revision: 1,
    status: 'waiting_human',
    nodes: { draft: { status: 'done', attempts: 1 }, approve: { status: 'waiting', attempts: 0 } },
    pending: [{ id: 'gate-1' }],
  }),
  inbox: async () => [{ id: 'gate-1', kind: 'gate', runId: 'run-1', nodeId: 'approve' }],
  describeFlow: async () => ({ alias: 'demo', flowId: 'fl', source: 'latest', currentRevision: 1, definition: gateFlow() }),
  validate: async () => ({ ok: true, errors: [], warnings: [] }),
  publish: async () => ({ revision: 2, contentHash: 'sha256:abc' }),
}

test('usage and unknown subcommands never throw', async () => {
  assert.match((await command(service).handler({ rawInput: '' })).text, /HNFlow 用法/u)
  const unknown = await command(service).handler({ rawInput: 'nope' })
  assert.equal(unknown.kind, 'error')
})

test('list and status render the catalogue and the node timeline', async () => {
  const list = await command(service).handler({ rawInput: 'list' })
  assert.match(list.text, /demo/u)
  const status = await command(service).handler({ rawInput: 'status run-1' })
  assert.match(status.text, /draft: done/u)
  assert.match(status.text, /待人工处理 1 项/u)
})

test('publish previews first and only confirms on the second word', async () => {
  const preview = await command(service).handler({ rawInput: 'publish demo' })
  assert.match(preview.text, /发布后为 r2/u)
  assert.match(preview.text, /确认发布/u)
  const confirmed = await command(service).handler({ rawInput: 'publish demo confirm' })
  assert.match(confirmed.text, /已发布 demo 为 r2/u)
  const noKey = await command(service).handler({ rawInput: 'publish' })
  assert.equal(noKey.kind, 'error')
})

test('a workspace command refuses to run without a workspace', async () => {
  const orphan = createFlowCommand({ service, cwdOf: () => null, config: resolveConfig({}), logger: {} })
  const result = await orphan.handler({ rawInput: 'list' })
  assert.equal(result.kind, 'error')
  // inbox is workspace-independent
  assert.equal((await orphan.handler({ rawInput: 'inbox' })).kind, 'success')
})

test('pin re-points a reference, and import creates a new asset', async () => {
  const seeded = await seedWorkspace(gateFlow(), { pinned: 1 })
  try {
    const config = resolveConfig({ libraryRoot: seeded.library })
    const flowService = {
      ...service,
      describeFlow: async (cwd, key) => ({ alias: key, flowId: 'fl-test', source: 'ref', currentRevision: 1, definition: gateFlow() }),
    }
    const cmd = createFlowCommand({ service: flowService, cwdOf: () => seeded.workspace, config, logger: {} })
    const pinned = await cmd.handler({ rawInput: 'pin demo latest' })
    assert.match(pinned.text, /跟随最新/u)

    const library = await cmd.handler({ rawInput: 'assets' })
    assert.match(library.text, /fl-test/u)

    const extra = gateFlow()
    extra.flow = { id: 'fl-extra', name: '通用流程' }
    await writeFile(
      path.join(seeded.library, 'extra.flow.json'),
      JSON.stringify({ asset: { id: 'fl-extra', name: '通用流程', revision: 1, tags: [] }, definition: extra }),
      'utf8',
    )
    const added = await cmd.handler({ rawInput: 'add fl-extra shared' })
    assert.match(added.text, /已引用/u)
    assert.match(added.text, /别名 shared/u)
    const missing = await cmd.handler({ rawInput: 'add fl-nope' })
    assert.equal(missing.kind, 'error')

    const file = path.join(seeded.workspace, 'new.flow.json')
    await mkdir(path.dirname(file), { recursive: true })
    const definition = gateFlow()
    definition.flow = { id: 'fl-new', name: '新流程' }
    await writeFile(file, JSON.stringify(definition), 'utf8')
    const imported = await cmd.handler({ rawInput: 'import 新流程 new.flow.json' })
    assert.match(imported.text, /已导入/u)
    const outside = await cmd.handler({ rawInput: 'import x ../escape.json' })
    assert.equal(outside.kind, 'error')
  } finally {
    await rm(seeded.root, { recursive: true, force: true })
  }
})
